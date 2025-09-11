const express = require('express');
const multer = require('multer');
const path = require('path');
const { randomUUID } = require('crypto');
const crypto = require('crypto');
const fsPromises = require('fs/promises'); // Use the promises version of fs
const { execFile, spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const tar = require('tar');
const path7za = require('7zip-bin').path7za;
const unzipper = require('unzipper');
const fs = require('fs'); // For synchronous checks
const sizeOf = require('image-size');

const app = express();
const port = 7878;

// --- Setup View Engine and Directories ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const dbPath = path.join(__dirname, 'database.json');
const uploadsDir = path.join(__dirname, 'uploads');
const tmpDir = path.join(uploadsDir, 'tmp'); // For temporary uploads
// Create uploads & tmp directory if they don't exist
[uploadsDir, tmpDir].forEach(dir => {
    if (!fs.existsSync(dir)){
        fs.mkdirSync(dir, { recursive: true });
    }
});

// --- Multer Configuration ---

// Storage engine for temporary uploads (used by POST)
const tmpStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, tmpDir),
  filename: function(req, file, cb){
    cb(null, crypto.randomBytes(16).toString('hex') + path.extname(file.originalname));
  }
});

// A single multer instance for all uploads, which go to the temp directory first.
const upload = multer({
  storage: tmpStorage, // Use temp storage for initial upload
  limits: { fileSize: 50000000 }, // 50MB file size limit for archives
  // File filtering is now handled inside the route to avoid ECONNRESET errors.
});

// Add middleware to parse JSON request bodies, which is needed for the PATCH endpoint.
app.use(express.json());

// --- Simple Async Lock for DB Operations ---
// This prevents race conditions when multiple requests try to read/write the db file at once.
let isDbLocked = false;
const dbWaitQueue = [];

async function acquireDbLock() {
    while (isDbLocked) {
        // If the lock is busy, wait for the previous operation to release it.
        await new Promise(resolve => dbWaitQueue.push(resolve));
    }
    isDbLocked = true;
}

function releaseDbLock() {
    isDbLocked = false;
    if (dbWaitQueue.length > 0) {
        dbWaitQueue.shift()(); // Notify the next waiting operation.
    }
}

// --- Middleware to prevent browser caching for API routes ---
app.use('/pictures', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
    next();
});

// --- Database Helper Functions ---

async function readDb() {
    try {
        await fsPromises.access(dbPath);
        const data = await fsPromises.readFile(dbPath, 'utf-8');
        // If the file is empty, return an empty object to prevent a JSON parsing error.
        if (data.trim() === '') {
            return {};
        }
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return {}; // If DB doesn't exist, start with an empty object
        }
        throw error;
    }
}

async function writeDb(data) {
    await fsPromises.writeFile(dbPath, JSON.stringify(data, null, 2));
}

async function findImageByDisplayName(db, displayName) {
    return Object.entries(db).find(([id, image]) => image.displayName === displayName);
}

function getImageMetadata(filePath, id, displayName) {
    try {
        const dimensions = sizeOf(filePath);
        return {
            id,
            displayName,
            link: `http://localhost:${port}/pictures/${id}`,
            ...dimensions
        };
    } catch (e) {
        console.error(`Could not get dimensions for ${displayName}:`, e.message);
        return null;
    }
}

async function getGalleryImages(db) {
    const imagePromises = Object.entries(db).map(async ([id, image]) => {
        const physicalPath = path.join(uploadsDir, image.physicalFilename);
        try {
            await fsPromises.access(physicalPath); // Check existence
            const metadata = getImageMetadata(physicalPath, id, image.displayName);
            return metadata ? { ...metadata, type: metadata.type.toUpperCase(), uploadedAt: image.uploadedAt } : null;
        } catch {
            return null; // File is in DB but not on disk
        }
    });
    const images = (await Promise.all(imagePromises)).filter(Boolean);
    return images.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
}

// --- API Endpoints ---

// Add a handler for favicon.ico to prevent 404s in the browser console
app.get('/favicon.ico', (req, res) => res.status(204).send());

/**
 * @route   GET /
 * @desc    Render the main page with all images
 * @access  Public
 */
async function renderIndex(req, res, activeView = 'gallery') {
  try {
    const db = await readDb();
    const images = await getGalleryImages(db);
    // Render the 'index.ejs' template, passing the image data and active view to it.
    res.render('index', { images, activeView });
  } catch (err) {
    // If reading files fails, render the page with an empty gallery.
    res.render('index', { images: [], activeView });
  }
}

// Route for the welcome/splash screen.
app.get('/', (req, res) => res.render('welcome'));
// Routes for the main application, defaulting to either gallery or upload view.
app.get('/gallery', (req, res) => renderIndex(req, res, 'gallery'));
app.get('/upload', (req, res) => renderIndex(req, res, 'upload'));

/**
 * @route   GET /pictures
 * @desc    API endpoint to get a JSON list of all pictures and their data.
 * @access  Public
 */
app.get('/pictures', async (req, res) => {
  try {
    const db = await readDb();
    const images = await getGalleryImages(db);
    res.json(images);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Unable to scan files.' });
  }
});

/**
 * @route   GET /pictures/:id
 * @desc    Serves an image by its permanent ID, making the link permanent.
 * @access  Public
 */
app.get('/pictures/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const db = await readDb();
        const imageEntry = db[id];

        if (!imageEntry) {
            return res.status(404).send('Image not found.');
        }

        const filePath = path.join(uploadsDir, imageEntry.physicalFilename);
        await fsPromises.access(filePath); // Check if file exists
        res.sendFile(filePath);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return res.status(404).send('Image file not found on disk.');
        }
        console.error("Error serving permanent link:", error);
        res.status(500).send('Server error.');
    }
});

// --- Helper Functions for Archive Processing ---

const imageFiletypes = /jpeg|jpg|png|gif|svg/;

const extractionStrategies = {
    '7z': async (filePath, extractFolder, tmpDir) => {
        const extractedImages = [];
        const ignoredFiles = [];
        // Use `spawn` instead of `execFile` for more robust handling of the child process.
        // `spawn` is better for potentially long-running tasks and avoids buffering issues
        // that can cause hangs, which was causing test timeouts.
        await new Promise((resolve, reject) => {
            // Command: 7z x [archive] -o[destination] -y
            // x: extract with full paths
            // -o: specify output directory (no space between -o and path)
            // -y: assume Yes to all queries (e.g., overwrite)
            const args = ['x', filePath, `-o${extractFolder}`, '-y'];
            const sevenZipProcess = spawn(path7za, args);

            // It's crucial to consume or ignore stdout and stderr to prevent the child process
            // from blocking when its internal buffers fill up.
            sevenZipProcess.stdout.on('data', () => {}); // We don't need stdout, so just drain it.

            let stderr = '';
            sevenZipProcess.stderr.on('data', (data) => {
                stderr += data;
            });

            sevenZipProcess.on('close', (code) => {
                // A non-zero exit code indicates an error.
                if (code === 0) {
                    resolve();
                } else {
                    console.error(`7z extraction process for ${path.basename(filePath)} failed with code ${code}. Stderr: ${stderr}`);
                    reject(new Error(`7z extraction failed: ${stderr || `Process exited with code ${code}`}`));
                }
            });

            sevenZipProcess.on('error', (err) => {
                // This event fires for errors in spawning the process itself (e.g., command not found).
                console.error(`Failed to start 7z process for ${path.basename(filePath)}.`, err);
                reject(err);
            });
        });

        // Helper to recursively find all files in the extracted directory.
        async function walk(dir) {
            let files = [];
            const items = await fsPromises.readdir(dir, { withFileTypes: true });
            for (const item of items) {
                const fullPath = path.join(dir, item.name);
                if (item.isDirectory()) {
                    files = files.concat(await walk(fullPath));
                } else {
                    files.push(fullPath);
                }
            }
            return files;
        }

        const allExtractedFilePaths = await walk(extractFolder);

        for (const tempPath of allExtractedFilePaths) {
            const originalFilename = path.basename(tempPath);
            if (imageFiletypes.test(path.extname(originalFilename).toLowerCase())) {
                // The file is already extracted. Pass its current path along for processing.
                // It will be moved to its final destination by `processImageFiles`.
                extractedImages.push({ originalFilename, tempPath });
            } else {
                ignoredFiles.push(originalFilename);
                // This file is not an image, so we can delete it immediately.
                await fsPromises.unlink(tempPath).catch(e => console.error(`Failed to clean up ignored file: ${tempPath}`, e));
            }
        }
        return { extractedImages, ignoredFiles };
    },
    'zip': async (filePath, extractFolder, tmpDir) => {
        const extractedImages = [];
        const ignoredFiles = [];
        const directory = await unzipper.Open.file(filePath);
        for (const entry of directory.files) {
            const originalFilename = path.basename(entry.path);
            if (entry.type !== 'File') continue;

            if (imageFiletypes.test(path.extname(originalFilename).toLowerCase())) {
                const tempFilename = randomUUID() + path.extname(originalFilename);
                const tempPath = path.join(extractFolder, tempFilename);
                await pipeline(entry.stream(), fs.createWriteStream(tempPath));
                extractedImages.push({ originalFilename, tempPath });
            } else {
                ignoredFiles.push(originalFilename);
            }
        }
        return { extractedImages, ignoredFiles };
    },
    'tar': async (filePath, extractFolder, tmpDir) => {
        const extractedImages = [];
        const ignoredFiles = [];
        await new Promise((resolve, reject) => {
            const parser = new tar.Parse();
            const promises = [];
            parser.on('entry', entry => {
                const originalFilename = path.basename(entry.path);
                if (entry.type !== 'File') { entry.resume(); return; }

                if (imageFiletypes.test(path.extname(originalFilename).toLowerCase())) {
                    const tempFilename = randomUUID() + path.extname(originalFilename);
                    const tempPath = path.join(extractFolder, tempFilename);
                    promises.push(pipeline(entry, fs.createWriteStream(tempPath)).then(() => {
                        extractedImages.push({ originalFilename, tempPath });
                    }));
                } else {
                    ignoredFiles.push(originalFilename);
                    entry.resume();
                }
            });
            parser.on('end', () => Promise.all(promises).then(resolve).catch(reject));
            parser.on('error', reject);
            fs.createReadStream(filePath).pipe(parser);
        });
        return { extractedImages, ignoredFiles };
    }
};

function getArchiveType(file) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.7z') return '7z';
    if (ext === '.zip') return 'zip';
    if (ext === '.tar' || ext === '.gz' || ext === '.tgz') return 'tar';
    return null;
}

async function unpackAndPrepareFiles(reqFiles, tmpDir) {
    const filesToProcess = [];
    const ignoredFromArchives = [];
    const foldersToClean = [];

    for (const file of reqFiles) {
        const archiveType = getArchiveType(file);
        if (archiveType) {
            const extractFolder = path.join(tmpDir, randomUUID());
            await fsPromises.mkdir(extractFolder);
            foldersToClean.push(extractFolder);

            try {
                const strategy = extractionStrategies[archiveType];
                const { extractedImages, ignoredFiles } = await strategy(file.path, extractFolder, tmpDir);
                filesToProcess.push(...extractedImages);
                ignoredFromArchives.push(...ignoredFiles);
            } catch (err) {
                console.error(`Failed to process archive ${file.originalname}:`, err);
                // We can decide to throw or just log and continue
            } finally {
                await fsPromises.unlink(file.path); // Clean up original archive
            }
        } else {
            filesToProcess.push({ originalFilename: file.originalname, tempPath: file.path });
        }
    }
    return { filesToProcess, ignoredFromArchives, foldersToClean };
}

async function processImageFiles(filesToProcess, db, tmpDir) {
    const extractedImages = [];
    const conflicts = [];
    const processingErrors = [];
    const batchDisplayNames = new Set();

    for (const { originalFilename, tempPath } of filesToProcess) {
        try {
            const existingInDb = await findImageByDisplayName(db, originalFilename);
            const isBatchDuplicate = batchDisplayNames.has(originalFilename);

            if (existingInDb || isBatchDuplicate) {
                const existingId = existingInDb ? existingInDb[0] : null;
                // The file at tempPath may be inside a temporary extraction folder that will be deleted.
                // We must move it to the main tmpDir to preserve it for conflict resolution.
                const newTempFilename = crypto.randomBytes(16).toString('hex') + path.extname(originalFilename);
                const newTempPath = path.join(tmpDir, newTempFilename);

                await fsPromises.rename(tempPath, newTempPath);

                // The conflict object now points to a stable temporary file.
                conflicts.push({ originalFilename, tempPath: newTempPath, existingId });
            } else {
                const id = randomUUID();
                const physicalFilename = id + path.extname(originalFilename);
                const finalPath = path.join(uploadsDir, physicalFilename);
                await fsPromises.rename(tempPath, finalPath);

                const metadata = getImageMetadata(finalPath, id, originalFilename);
                if (metadata) {
                    db[id] = { displayName: originalFilename, physicalFilename, uploadedAt: new Date().toISOString(), ...metadata };
                    batchDisplayNames.add(originalFilename);
                    extractedImages.push(metadata);
                } else {
                    processingErrors.push(`Could not process metadata for ${originalFilename}.`);
                    await fsPromises.unlink(finalPath);
                }
            }
        } catch (e) {
            console.error(`Error processing ${originalFilename}:`, e);
            processingErrors.push(`Failed to process ${originalFilename}.`);
            if (fs.existsSync(tempPath)) {
                await fsPromises.unlink(tempPath).catch(err => console.error(`Cleanup failed for ${tempPath}`, err));
            }
        }
    }
    return { successfulUploads: extractedImages, conflicts, processingErrors };
}

/**
 * @route   POST /pictures
 * @desc    API endpoint to upload a new picture.
 * @access  Public
 */
app.post('/pictures', (req, res) => {
  upload.array('myImage', 20)(req, res, async (err) => {
    if (err) { // This will catch multer-specific errors (e.g., file size)
      console.error('[DIAGNOSTIC] Multer returned an error:', err);
      if (err instanceof multer.MulterError) {
        return res.status(400).json({ message: err.message });
      }
      // For any other unexpected errors
      console.error('An unknown upload error occurred:', err);
      return res.status(500).json({ message: 'An unknown server error occurred.' });
    }

    await acquireDbLock();
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ message: 'Error: No Files Selected!' });
        }

        // Validate file types after upload to prevent ECONNRESET errors.
        // If any file in the batch is invalid, reject the entire batch.
        const allowedFiletypes = /jpeg|jpg|png|gif|svg|zip|gz|tar|7z/;
        const invalidFiles = req.files.filter(file => 
            !allowedFiletypes.test(path.extname(file.originalname).toLowerCase())
        );

        if (invalidFiles.length > 0) {
            // Clean up all files that were uploaded in this request.
            const cleanupPromises = req.files.map(file => 
                fsPromises.unlink(file.path).catch(e => console.error(`Failed to clean up invalid upload: ${file.path}`, e))
            );
            await Promise.all(cleanupPromises);

            // Send the error response. The test expects this specific generic message.
            return res.status(400).json({ 
                message: "Unsupported file format: only images and archives (.zip, .tar.gz, .tar, .7z) are allowed." 
            });
        }

        // Step 1: Unpack archives and create a single list of files to process
        const { filesToProcess, ignoredFromArchives, foldersToClean } = await unpackAndPrepareFiles(req.files, tmpDir);

        // Step 2: Process the unified list of files for conflicts and saving
        const db = await readDb();
        const { successfulUploads, conflicts, processingErrors } = await processImageFiles(filesToProcess, db, tmpDir);
        await writeDb(db);

        // Step 3: Clean up temporary extraction folders
        for (const folder of foldersToClean) {
            await fsPromises.rm(folder, { recursive: true, force: true }).catch(e => console.error(`Failed to clean up extract folder: ${folder}`, e));
        }

        // Step 4: Build and send the response
        const messageParts = [];
        if (successfulUploads.length > 0) messageParts.push(`${successfulUploads.length} image file(s) were added.`);
        if (conflicts.length > 0) messageParts.push(`${conflicts.length} file(s) have naming conflicts.`);
        if (processingErrors.length > 0) messageParts.push(`${processingErrors.length} file(s) failed to process.`);

        if (successfulUploads.length === 0 && conflicts.length === 0 && ignoredFromArchives.length > 0) {
            return res.status(200).json({ message: 'Upload complete. 0 files were uploaded thats it.', ignored: ignoredFromArchives });
        }

        if (successfulUploads.length === 0 && conflicts.length === 0 && filesToProcess.length === 0) {
            return res.status(400).json({ message: 'No valid image files found in the upload.' });
        }

        const finalMessage = messageParts.join(' ') || 'Processing complete.';
        const statusCode = conflicts.length > 0 ? 207 : 200;

        res.status(statusCode).json({
            message: finalMessage,
            successful: successfulUploads,
            conflicts: conflicts,
            ignored: ignoredFromArchives,
            errors: processingErrors,
        });
    } catch (processingErr) {
        console.error('FATAL: An unexpected error occurred in the main processing block:', processingErr);
        res.status(500).json({ message: 'An error occurred while processing the uploaded files.' });
    } finally {
        releaseDbLock();
    }
  });
});

/**
 * @route   POST /pictures/resolve-conflict
 * @desc    API endpoint to resolve a file upload conflict.
 * @access  Public
 */
app.post('/pictures/resolve-conflict', async (req, res) => {
    const { action, tempPath, existingId, newFilename } = req.body;

    // Security check: ensure tempPath is within the tmpDir to prevent path traversal attacks.
    const resolvedTempPath = path.resolve(tempPath);
    const resolvedTmpDir = path.resolve(tmpDir);
    if (!resolvedTempPath.startsWith(resolvedTmpDir)) {
        return res.status(403).json({ message: 'Invalid temporary file path.' });
    }

    await acquireDbLock();
    try {
        await fsPromises.access(tempPath); // Check if temp file still exists
        const db = await readDb();

        switch (action) {
            case 'overwrite':
                const existingEntry = db[existingId];
                if (!existingEntry) return res.status(404).json({ message: 'Image to overwrite not found.' });
                
                const oldPhysicalPath = path.join(uploadsDir, existingEntry.physicalFilename);
                const newPhysicalFilename = existingId + path.extname(existingEntry.displayName);
                const newPhysicalPath = path.join(uploadsDir, newPhysicalFilename);

                await fsPromises.rename(tempPath, newPhysicalPath);
                if (fs.existsSync(oldPhysicalPath) && oldPhysicalPath !== newPhysicalPath) {
                    await fsPromises.unlink(oldPhysicalPath);
                }

                const metadata = getImageMetadata(newPhysicalPath, existingId, existingEntry.displayName);
                db[existingId] = { ...existingEntry, ...metadata, physicalFilename: newPhysicalFilename, uploadedAt: new Date().toISOString() };
                await writeDb(db);
                res.status(200).json({ message: `File '${existingEntry.displayName}' was overwritten.` });
                break;

            case 'rename':
                if (await findImageByDisplayName(db, newFilename)) {
                    return res.status(409).json({ message: `A file with the display name '${newFilename}' already exists.` });
                }
                const id = randomUUID();
                const physicalFilename = id + path.extname(newFilename);
                const finalPath = path.join(uploadsDir, physicalFilename);
                await fsPromises.rename(tempPath, finalPath);

                const newMetadata = getImageMetadata(finalPath, id, newFilename);
                db[id] = { ...newMetadata, physicalFilename, uploadedAt: new Date().toISOString(), displayName: newFilename };
                await writeDb(db);
                res.status(200).json({ message: `File saved as '${newFilename}'.` });
                break;

            case 'skip':
                const { originalFilename } = req.body;
                await fsPromises.unlink(tempPath);
                res.status(200).json({ message: `Upload of '${originalFilename}' was skipped.` });
                break;
            default:
                res.status(400).json({ message: 'Invalid action specified.' });
        }
    } catch (error) {
        console.error("Conflict resolution error:", error);
        if (error.code === 'ENOENT') {
            return res.status(404).json({ message: 'Temporary file not found. It may have expired or been processed already.' });
        }
        res.status(500).json({ message: 'An error occurred while resolving the conflict.' });
    } finally {
        releaseDbLock();
    }
});

/**
 * @route   PUT /pictures/:id
 * @desc    API endpoint to update/replace an existing picture.
 * @access  Public
 */
app.put('/pictures/:id', (req, res) => {
  upload.single('myImage')(req, res, async (uploadErr) => {
    const { id } = req.params;
    if (uploadErr) {
      if (uploadErr instanceof multer.MulterError) {
        return res.status(400).json({ message: uploadErr.message });
      }
      // For any other unexpected errors
      console.error(uploadErr);
      return res.status(500).json({ message: 'An unknown server error occurred during upload.' });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'Error: No new file selected for update.' });
    }

    // Ensure only images are used for replacement
    const imageFiletypes = /jpeg|jpg|png|gif|svg/;
    const isImage = imageFiletypes.test(path.extname(req.file.originalname).toLowerCase());

    if (!isImage) {
        // Clean up the wrongly uploaded file (e.g., a zip)
        await fsPromises.unlink(req.file.path);
        return res.status(400).json({ message: 'Only image files can be used to replace an existing image.' });
    }

    // Now, acquire the lock to perform the final atomic update.
    await acquireDbLock();
    try {
        const db = await readDb(); // Re-read the DB to get the latest state
        const imageEntry = db[id];

        // Check for the ID's existence now that the file has been handled.
        if (!imageEntry) {
            await fsPromises.unlink(req.file.path); // Clean up the uploaded temp file
            return res.status(404).json({ message: 'Image not found.' });
        }

        const oldFilePath = path.join(uploadsDir, imageEntry.physicalFilename);
        const newPhysicalFilename = id + path.extname(req.file.originalname);
        const newFilePath = path.join(uploadsDir, newPhysicalFilename);

        await fsPromises.rename(req.file.path, newFilePath);
        const metadata = getImageMetadata(newFilePath, id, req.file.originalname);
        db[id] = { ...imageEntry, ...metadata, displayName: req.file.originalname, physicalFilename: newPhysicalFilename, uploadedAt: new Date().toISOString() };
        await writeDb(db);

        try {
          if (fs.existsSync(oldFilePath) && oldFilePath !== newFilePath) await fsPromises.unlink(oldFilePath);
        } catch (cleanupErr) {
          console.error(`Failed to clean up old file ${oldFilePath} during PUT operation:`, cleanupErr);
        }

        res.status(200).json({
          message: 'File updated successfully',
          link: `http://localhost:${port}/pictures/${id}`
        });
    } finally {
        releaseDbLock();
    }
  });
});

/**
 * @route   PATCH /pictures/:id
 * @desc    API endpoint to update an image's filename.
 * @access  Public
 */
app.patch('/pictures/:id', async (req, res) => {
  // Acquire the lock before the try block.
  await acquireDbLock();
  try {
    const { id } = req.params;
    const { newFilename } = req.body;

    if (!newFilename) {
      return res.status(400).json({ message: 'New filename is required.' });
    }

    const db = await readDb();
    if (!db[id]) {
      return res.status(404).json({ message: 'Image not found.' });
    }

    if (await findImageByDisplayName(db, newFilename)) {
      return res.status(409).json({ message: 'A file with this display name already exists.' });
    }

    db[id].displayName = newFilename;
    await writeDb(db);
    res.status(200).json({ message: 'Filename updated successfully.' });
  } catch (err) {
    console.error("DB write error on PATCH:", err);
    res.status(500).json({ message: 'Failed to update filename.' });
  } finally {
    releaseDbLock();
  }
});

/**
 * @route   DELETE /pictures
 * @desc    API endpoint to delete one or more pictures.
 * @access  Public
 */
app.delete('/pictures', async (req, res) => {
    const { ids } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ message: 'An array of image IDs is required.' });
    }

    await acquireDbLock();
    try {
        const db = await readDb();
        let deletedCount = 0;
        const deletionErrors = [];

        for (const id of ids) {
            const imageEntry = db[id];
            if (imageEntry) {
                const filePath = path.join(uploadsDir, imageEntry.physicalFilename);
                try {
                    // Unlink file first, then remove from DB
                    await fsPromises.unlink(filePath);
                    delete db[id];
                    deletedCount++;
                } catch (fileErr) {
                    if (fileErr.code !== 'ENOENT') { // Ignore if file is already gone
                        deletionErrors.push(`Failed to delete file for ID ${id}.`);
                        console.error(`File deletion error for ${id}:`, fileErr);
                    } else {
                        delete db[id]; // Still remove from DB if file is missing
                    }
                }
            }
        }

        await writeDb(db);
        res.status(200).json({ message: `${deletedCount} image(s) deleted successfully.` });
    } catch (err) {
        console.error("Bulk delete error:", err);
        res.status(500).json({ message: 'An error occurred during the delete operation.' });
    } finally {
        releaseDbLock();
    }
});

// --- Global Error Handler ---
// This should be the last middleware. It catches errors that occur in routes.
app.use((error, req, res, next) => {
    console.error('[FATAL] A global error handler caught an error:', error);
    if (error instanceof multer.MulterError) {
        // A Multer-specific error occurred (e.g., file too large).
        return res.status(400).send({ message: `File upload error: ${error.message}` });
    } else if (error) {
        // An unknown error occurred.
        return res.status(500).send({ message: 'An internal server error occurred.' });
    }
    // If no error, continue to the next middleware
    next();
});

// --- 4. SERVER INITIALIZATION ---

// Start the server
if (require.main === module) {
  app.listen(port, () => console.log(`Server started on port ${port}`));
}

// Export the app object for testing purposes
module.exports = app;