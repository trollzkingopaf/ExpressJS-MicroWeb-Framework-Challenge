const express = require('express');
const multer = require('multer');
const path = require('path');
const fsPromises = require('fs/promises'); // Use the promises version of fs
const fs = require('fs'); // For synchronous checks
const sizeOf = require('image-size');

const app = express();
const port = 7878;

// --- Setup View Engine and Directories ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const uploadsDir = path.join(__dirname, 'uploads');
// Create uploads directory if it doesn't exist
if (!fs.existsSync(uploadsDir)){
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// --- Multer Configuration ---

// Storage engine defines how files are stored.
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: function(req, file, cb){
    cb(null, file.originalname);
  }
});

// File filter to only accept images.
const fileFilter = (req, file, cb) => {
  // Regular expression to check for image file extensions.
  const filetypes = /jpeg|jpg|png|gif|svg/;
  // Check the file extension
  const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
  // Check the mime type
  const mimetype = filetypes.test(file.mimetype);

  if(mimetype && extname){
    // If it's an image, accept the file.
    return cb(null, true);
  } else {
    // If it's not an image, reject the file.
    // This error message will be caught in the endpoint handler.
    cb("Unsupported file format");
  }
};

// Initialize multer with the storage engine, file filter, and limits.
const upload = multer({
  storage: storage,
  limits: { fileSize: 10000000 }, // 10MB file size limit
  fileFilter: fileFilter
}).single('myImage'); // 'myImage' is the name of the form field from your tests.

// Add middleware to parse JSON request bodies, which is needed for the PATCH endpoint.
app.use(express.json());

// --- API Endpoints ---

// Make the 'uploads' directory publicly accessible to serve the images
app.use('/uploads', express.static(uploadsDir));

/**
 * @route   GET /
 * @desc    Render the main page with all images
 * @access  Public
 */
async function renderIndex(req, res, activeView = 'gallery') {
  try {
    const files = await fsPromises.readdir(uploadsDir);
    const images = files.map(file => { 
      try {
        const dimensions = sizeOf(path.join(uploadsDir, file));
        return {
          filename: file,
          link: `http://localhost:${port}/uploads/${file}`,
          type: dimensions.type.toUpperCase(),
          width: dimensions.width,
          height: dimensions.height
        };
      } catch (e) {
        console.error(`Could not get dimensions for ${file}:`, e.message);
        return null; // In case of error (e.g., non-image file)
      }
    }).filter(Boolean).reverse(); // Filter out nulls and reverse

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
    const files = await fsPromises.readdir(uploadsDir);
    const fileLinks = files.map(file => {
      try {
        const dimensions = sizeOf(path.join(uploadsDir, file));
        return {
          filename: file,
          link: `http://localhost:${port}/uploads/${file}`,
          type: dimensions.type.toUpperCase(),
          width: dimensions.width,
          height: dimensions.height
        };
      } catch (e) {
        console.error(`Could not get dimensions for ${file}:`, e.message);
        return null;
      }
    }).filter(Boolean);
    res.json(fileLinks.reverse());
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Unable to scan files.' });
  }
});

/**
 * @route   POST /pictures
 * @desc    API endpoint to upload a new picture.
 * @access  Public
 */
app.post('/pictures', (req, res) => {
  upload(req, res, (err) => {
    if (err) {
      // This will catch custom string errors from fileFilter
      if (typeof err === 'string') {
        return res.status(400).json({ message: err });
      }
      // This will catch multer-specific errors (e.g., file size)
      if (err instanceof multer.MulterError) {
        return res.status(400).json({ message: err.message });
      }
      // For any other unexpected errors
      console.error(err);
      return res.status(500).json({ message: 'An unknown server error occurred.' });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'Error: No File Selected!' });
    }

    res.status(200).json({
      message: 'File uploaded successfully',
      link: `http://localhost:${port}/uploads/${req.file.filename}`
    });
  });
});

/**
 * @route   PUT /pictures/:filename
 * @desc    API endpoint to update/replace an existing picture.
 * @access  Public
 */
app.put('/pictures/:filename', async (req, res) => {
  const oldFilename = req.params.filename;
  const oldFilePath = path.join(uploadsDir, oldFilename);

  try {
    // 1. Check if the file to replace exists. fs.access throws if it doesn't.
    await fsPromises.access(oldFilePath);
  } catch (err) {
    return res.status(404).json({ message: 'File to update not found.' });
  }

  // 2. Proceed with uploading the new file.
  upload(req, res, async (uploadErr) => {
    if (uploadErr) {
      // This will catch custom string errors from fileFilter
      if (typeof uploadErr === 'string') {
        return res.status(400).json({ message: uploadErr });
      }
      // This will catch multer-specific errors (e.g., file size)
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

    // 3. After the new file is successfully uploaded, delete the old one.
    try {
      await fsPromises.unlink(oldFilePath);
    } catch (unlinkErr) {
      // This is a cleanup error, but the update was successful. Log it.
      console.error('Failed to delete old file during update:', unlinkErr);
    }

    res.status(200).json({
      message: 'File updated successfully',
      link: `http://localhost:${port}/uploads/${req.file.filename}`
    });
  });
});

/**
 * @route   PATCH /pictures/:filename
 * @desc    API endpoint to update an image's filename.
 * @access  Public
 */
app.patch('/pictures/:filename', async (req, res) => {
  const { filename } = req.params;
  const { newFilename } = req.body;

  if (!newFilename) {
    return res.status(400).json({ message: 'New filename is required.' });
  }

  const oldFilePath = path.join(uploadsDir, filename);
  const newFilePath = path.join(uploadsDir, newFilename);

  try {
    // 1. Check if the original file exists.
    await fsPromises.access(oldFilePath);

    // 2. Check if a file with the new name already exists to prevent overwriting.
    try {
      await fsPromises.access(newFilePath);
      // If the above line doesn't throw, the file exists.
      return res.status(409).json({ message: 'A file with this name already exists.' });
    } catch (error) {
      // This is the expected case: the new file path is available.
    }

    // 3. Rename the file.
    await fsPromises.rename(oldFilePath, newFilePath);
    res.status(200).json({ message: 'Filename updated successfully.' });
  } catch (err) {
    res.status(404).json({ message: 'File not found.' });
  }
});

/**
 * @route   DELETE /pictures/:filename
 * @desc    API endpoint to delete a picture.
 * @access  Public
 */
app.delete('/pictures/:filename', async (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'uploads', filename);

  try {
    await fsPromises.unlink(filePath);
    res.status(200).json({ message: 'File deleted successfully.' });
  } catch (err) {
    if (err) {
      // If the file doesn't exist, fs.unlink gives an ENOENT error.
      if (err.code === 'ENOENT') {
        return res.status(404).json({ message: 'File not found.' });
      }
      // For other errors (e.g., permissions)
      console.error(err);
      return res.status(500).json({ message: 'Error deleting the file.' });
    }
  }
});

// --- 4. SERVER INITIALIZATION ---

// Start the server
const server = app.listen(port, () => console.log(`Server started on port ${port}`));

// Export the server so it can be imported and used by our test files.
module.exports = server;