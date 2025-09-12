const request = require('supertest');
const chai = require('chai');
const expect = chai.expect;
const app = require('../story2.2.js'); // Import the app
const path = require('path');
const { execFile } = require('child_process');
const fs = require('fs/promises');
const JSZip = require('jszip');
const { randomUUID } = require('crypto');
const Seven = require('node-7z');
const path7za = require('7zip-bin').path7za;
const sharp = require('sharp');

const uploadsDir = path.join(__dirname, '../uploads');
const tmpDir = path.join(uploadsDir, 'tmp');

// Define paths for test files, assuming they are in a 'test-files' subdirectory
const testFilesDir = path.join(__dirname, 'test-files');
const testImagePath = path.join(testFilesDir, 'valid-image.png'); // Use a generic name
const largeImagePath = path.join(testFilesDir, 'large-image.jpg');
const smallImagePath = path.join(testFilesDir, 'small-image.png');
const testNonImagePath = path.join(testFilesDir, 'not_an_image.txt');

const testZipPath = path.join(__dirname, 'test_images.zip');
const test7zPath = path.join(__dirname, 'test_images.7z');
const testConflictZipPath = path.join(__dirname, 'test_conflict_images.zip');

// Helper function to reset the application state before tests.
async function cleanTestState() {
  await fs.unlink(path.join(__dirname, '../database.json')).catch(err => { if (err.code !== 'ENOENT') throw err; });
  await fs.rm(uploadsDir, { recursive: true, force: true }).catch(err => { if (err.code !== 'ENOENT' && err.code !== 'EPERM') throw err; });
  await fs.mkdir(tmpDir, { recursive: true });
}

describe('Microweb Image Framework', () => {

  const temp7zSourceDir = path.join(__dirname, 'temp_7z_source');

  before(async function() {
    this.timeout(10000); // Increase timeout for setup which involves creating archives.
    try {
      await fs.rm(testFilesDir, { recursive: true, force: true }).catch(()=>{});
      await fs.mkdir(testFilesDir, { recursive: true });

      // Programmatically create test files to ensure tests are self-contained
      await sharp({ create: { width: 150, height: 150, channels: 3, background: { r: 0, g: 255, b: 0 } } }).png().toFile(testImagePath);
      await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 255, g: 0, b: 0 } } }).jpeg().toFile(largeImagePath);
      await sharp({ create: { width: 50, height: 50, channels: 3, background: { r: 0, g: 0, b: 255 } } }).png().toFile(smallImagePath);
      await fs.writeFile(testNonImagePath, 'This is not an image.');

      // Create a test zip file for upload tests
      const zip = new JSZip();
      const imgData = await fs.readFile(testImagePath);
      const txtData = await fs.readFile(testNonImagePath, 'utf-8');
      zip.file('valid-image.png', imgData); // This name will conflict with the first test's upload
      zip.file('another_image.png', imgData);
      zip.file('folder/nested_image.png', imgData); // To test basename extraction
      zip.file('folder/another_image.png', imgData); // To test intra-archive conflicts
      zip.file('should_be_ignored.txt', txtData);
      
      const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
      await fs.writeFile(testZipPath, zipBuffer);

      // Create a test 7z file for upload tests, mirroring the zip file's contents
      await fs.rm(temp7zSourceDir, { recursive: true, force: true }); // Clean up from previous runs
      await fs.mkdir(temp7zSourceDir, { recursive: true });
      await fs.copyFile(testImagePath, path.join(temp7zSourceDir, 'valid-image.png'));
      await fs.copyFile(testImagePath, path.join(temp7zSourceDir, 'another_image.png'));
      await fs.mkdir(path.join(temp7zSourceDir, 'folder'));
      await fs.copyFile(testImagePath, path.join(temp7zSourceDir, 'folder', 'nested_image.png'));
      await fs.copyFile(testImagePath, path.join(temp7zSourceDir, 'folder', 'another_image.png'));
      await fs.copyFile(testNonImagePath, path.join(temp7zSourceDir, 'should_be_ignored.txt'));
 
      // Use child_process.execFile directly for more control and to bypass potential library abstraction issues.
      // The 'a' command adds to an archive. '.' refers to all files in the `cwd`.
      await new Promise((resolve, reject) => {
        // The wildcard '*' is not expanded by execFile. The correct way is to use '.' as the
        // source and specify the `cwd` (current working directory).
        execFile(path7za, ['a', '-r', test7zPath, '.'], { cwd: temp7zSourceDir }, (err, stdout, stderr) => {
            if (err) {
                console.error('7z creation failed:', stderr);
                return reject(err);
            }
            resolve(stdout);
        });
      });
      // Verify that the file was actually created before proceeding.
      await fs.access(test7zPath);

    } catch (error) {
      console.error("Could not set up uploads directory before tests:", error);
      throw error; // Re-throw the error to ensure the test suite stops if setup fails.
    }
  });

  after(async () => {
    try {
      await fs.rm(testFilesDir, { recursive: true, force: true });
      await fs.unlink(path.join(__dirname, '../database.json')).catch(() => {});
      await fs.rm(temp7zSourceDir, { recursive: true, force: true });
      await fs.rm(uploadsDir, { recursive: true, force: true });
      await fs.unlink(testZipPath); // Clean up zip
      await fs.unlink(test7zPath); // Clean up 7z
      await fs.unlink(testConflictZipPath).catch(() => {});
    } catch (error) {
      console.error("Could not clean up uploads directory after tests:", error);
    }
  });

  describe('Page Rendering', () => {
    it('GET / should render the welcome page', async () => {
      const res = await request(app)
        .get('/')
        .expect(200);
      expect(res.text).to.include('Welcome - Microweb Image Framework');
      expect(res.text).to.include("Let's Go");
    });

    it('GET /gallery should render the main application page', async () => {
      const res = await request(app)
        .get('/gallery')
        .expect(200);
      expect(res.text).to.include('Microweb Image Framework');
      expect(res.text).to.include('Image Gallery');
    });
  });

  describe('API CRUD Operations (/pictures)', () => {
    
    // CREATE
    describe('POST /pictures', () => {
      // Isolate each POST test to prevent state pollution.
      // This is crucial for reliable testing.
      beforeEach(cleanTestState);

      it('should upload an image successfully and return its new ID and metadata', async () => {
        const res = await request(app)
          .post('/pictures')
          .attach('myImage', testImagePath)
          .expect(200);
            expect(res.body.message).to.equal('1 image file(s) were added.');
            expect(res.body.successful).to.be.an('array').with.lengthOf(1);
            const uploadedImage = res.body.successful[0];
            expect(uploadedImage).to.have.property('id');
            expect(uploadedImage.displayName).to.equal('valid-image.png');
      });

      it('should return a 207 conflict status if a file with the same display name already exists', async () => {
        // This test is self-contained. It creates its own state.
        const initialUpload = await request(app).post('/pictures').attach('myImage', testImagePath);
        const uploadedImageId = initialUpload.body.successful[0].id;

        // Then, it attempts the conflicting action.
        const res = await request(app)
          .post('/pictures')
          .attach('myImage', testImagePath)
          .expect(207);
        expect(res.body.message).to.include('1 file(s) have naming conflicts.');
        expect(res.body.conflicts[0].existingId).to.equal(uploadedImageId);

        // Clean up the temporary conflict file created by the server
        if (res.body.conflicts && res.body.conflicts[0]) {
            await fs.unlink(res.body.conflicts[0].tempPath).catch(() => {});
        }
      });

      it('should reject a non-image file', async () => {
        const res = await request(app)
          .post('/pictures')
          .attach('myImage', testNonImagePath)
          .expect(400);
        expect(res.body).to.be.an('object');
        expect(res.body.message).to.include('Unsupported file format');
      });

      it('should return an error if no file is selected', async () => {
        const res = await request(app)
          .post('/pictures')
          .expect(400);
        expect(res.body).to.have.property('message', 'Error: No Files Selected!');
      });

      it('should generate thumbnails for an image larger than 128x128', async () => {
        const res = await request(app)
            .post('/pictures')
            .attach('myImage', largeImagePath)
            .expect(200);

        expect(res.body.successful[0].thumbnails).to.be.an('object');
        expect(res.body.successful[0].thumbnails).to.have.property('32');
        expect(res.body.successful[0].thumbnails).to.have.property('64');

        // Check if thumbnail files were actually created on disk
        const thumb32Path = path.join(uploadsDir, res.body.successful[0].thumbnails['32']);
        const thumb64Path = path.join(uploadsDir, res.body.successful[0].thumbnails['64']);
        
        await fs.access(thumb32Path);
        await fs.access(thumb64Path);
      });

      it('should NOT generate thumbnails for an image smaller than 128x128', async () => {
        const res = await request(app)
            .post('/pictures')
            .attach('myImage', smallImagePath)
            .expect(200);

        expect(res.body.successful[0].thumbnails).to.be.null;
      });

      // --- New tests for ZIP functionality ---
      describe('with ZIP file', () => {
        // Before each test in this suite, ensure a clean state and then
        // seed the database with one conflicting file.
        beforeEach(async () => {
            await cleanTestState();
            await request(app).post('/pictures').attach('myImage', testImagePath);
        });

        it('should upload all new images from a zip file, skipping existing ones', async () => {
            const res = await request(app)
                .post('/pictures')
                .attach('myImage', testZipPath) // Contains test_image.png (conflict), another_image.png (new), nested_image.png (new), and another_image.png (intra-archive conflict)
                .expect(207);
            expect(res.body.message).to.equal('2 image file(s) were added. 2 file(s) have naming conflicts.');
            expect(res.body.successful).to.be.an('array').with.lengthOf(2);
            expect(res.body.conflicts).to.be.an('array').with.lengthOf(2);
            const filenames = res.body.successful.map(f => f.displayName);
            expect(filenames).to.have.members(['another_image.png', 'nested_image.png']);
        });

        it('should return a 200 with an "ignored" message if zip contains only non-image files', async () => {
            const zip = new JSZip();
            zip.file('empty.txt', 'hello');
            const buffer = await zip.generateAsync({ type: 'nodebuffer' });
            const res = await request(app)
                .post('/pictures')
                .attach('myImage', buffer, 'no_images.zip')
                .expect(200);
            expect(res.body.message).to.equal('Upload complete. 0 files were uploaded thats it.');
            expect(res.body.ignored).to.have.members(['empty.txt']);
        });
      });

      // --- New tests for 7z functionality ---
      describe('with 7z file', () => {
        // Isolate these tests by resetting state and seeding the DB for a conflict.
        beforeEach(async function() {
            await cleanTestState();
            await request(app).post('/pictures').attach('myImage', testImagePath);
        });

        it('should upload all new images from a 7z file, skipping existing ones', async function() {
            this.timeout(15000); // Increase timeout for 7z extraction
            const res = await request(app)
                .post('/pictures')
                .attach('myImage', test7zPath) // Contains same files as zip
                .expect(207);
            
            expect(res.body.message).to.equal('2 image file(s) were added. 2 file(s) have naming conflicts.');
            expect(res.body.successful).to.be.an('array').with.lengthOf(2);
            expect(res.body.conflicts).to.be.an('array').with.lengthOf(2);
            const filenames = res.body.successful.map(f => f.displayName);
            expect(filenames).to.have.members(['another_image.png', 'nested_image.png']);
            // Safely clean up all temporary conflict files
            await Promise.all(res.body.conflicts.map(c => fs.unlink(c.tempPath)));
        });

        it('should return a 200 with an "ignored" message if 7z contains only non-image files', async function() {
            this.timeout(5000); // Increase timeout for 7z extraction
            const noImages7zPath = path.join(__dirname, 'no_images.7z');
            
            // Promisify the stream-based 7z creation
            await new Promise((resolve, reject) => {
                const stream = Seven.add(noImages7zPath, [testNonImagePath], { $bin: path7za });
                stream.on('end', resolve);
                stream.on('error', reject);
            });

            try {
                const res = await request(app)
                    .post('/pictures')
                    .attach('myImage', noImages7zPath, 'no_images.7z')
                    .expect(200);
                
                expect(res.body.message).to.equal('Upload complete. 0 files were uploaded thats it.');
                expect(res.body.ignored).to.have.members([path.basename(testNonImagePath)]);
            } finally {
                // Ensure cleanup happens even if assertions fail
                await fs.unlink(noImages7zPath).catch(() => {});
            }
        });
      });
    });

    describe('POST /pictures/resolve-conflict', () => {
        let conflict;

        // Before each test, create a fresh conflict situation to resolve.
        beforeEach(async () => {
            await cleanTestState();
            await request(app).post('/pictures').attach('myImage', testImagePath);
            const res = await request(app)
                .post('/pictures')
                .attach('myImage', testImagePath)
                .expect(207);
            conflict = res.body.conflicts[0];
        });

        it('should resolve a conflict by renaming the new file', async () => {
            const newFilename = 'renamed_from_conflict.png';
            const res = await request(app)
                .post('/pictures/resolve-conflict')
                .send({
                    action: 'rename',
                    tempPath: conflict.tempPath,
                    newFilename: newFilename
                })
                .expect(200);
            expect(res.body.message).to.equal(`File saved as '${newFilename}'.`);
            // Verify it's in the DB
            const galleryRes = await request(app).get('/pictures');
            const found = galleryRes.body.some(img => img.displayName === newFilename);
            expect(found).to.be.true;
        });

        it('should resolve a conflict by overwriting the existing file', async () => {
            const res = await request(app)
                .post('/pictures/resolve-conflict')
                .send({
                    action: 'overwrite',
                    tempPath: conflict.tempPath,
                    existingId: conflict.existingId
                })
                .expect(200);
            expect(res.body.message).to.equal(`File '${conflict.originalFilename}' was overwritten.`);
        });

        it('should resolve a conflict by skipping the new file', async () => {
            const res = await request(app)
                .post('/pictures/resolve-conflict')
                .send({
                    action: 'skip',
                    tempPath: conflict.tempPath,
                    originalFilename: conflict.originalFilename
                })
                .expect(200);
            expect(res.body.message).to.equal(`Upload of '${conflict.originalFilename}' was skipped.`);
            // Verify the temp file was deleted
            try {
                await fs.access(conflict.tempPath);
                // If this line is reached, the file exists, which is an error.
                throw new Error('Temp file was not deleted');
            } catch (err) {
                // We expect an ENOENT error, which means the file was correctly deleted.
                expect(err.code).to.equal('ENOENT');
            }
        });
    });

    // READ
    describe('GET /pictures', () => {
      // Isolate this test by cleaning state first.
      beforeEach(cleanTestState);

      it('should return a list containing the uploaded image with its metadata', async () => {
        const uploadRes = await request(app).post('/pictures').attach('myImage', testImagePath);
        const uploadedImageId = uploadRes.body.successful[0].id;
        const res = await request(app)
          .get('/pictures')
          .expect(200);
            expect(res.body).to.be.an('array').with.lengthOf(1, 'Expected to find one image in the gallery');
            const image = res.body.find(img => img.id === uploadedImageId);
            expect(image).to.exist;
            expect(image).to.have.property('link');
            expect(image).to.have.property('type');
            expect(image).to.have.property('width');
            expect(image).to.have.property('height');
      });
    });

    // UPDATE
    describe('PUT /pictures/:id', () => {
        const newImageName = 'new_test_image.png';
        const newImagePath = path.join(testFilesDir, newImageName);
        let imageToUpdate;

        // Before each test, clean state and upload one image to be updated.
        beforeEach(async () => {
            await cleanTestState();
            const res = await request(app).post('/pictures').attach('myImage', testImagePath);
            imageToUpdate = res.body.successful[0];
            await fs.copyFile(testImagePath, newImagePath);
        });

        // Clean up the temporary replacement image file.
        afterEach(async () => await fs.unlink(newImagePath).catch(()=>{}));

        it('should replace an existing image with a new one using its ID', async () => {
            const res = await request(app)
                .put(`/pictures/${imageToUpdate.id}`)
                .attach('myImage', newImagePath)
                .expect(200);
            expect(res.body.message).to.equal('File updated successfully');
            expect(res.body.link).to.include(imageToUpdate.id);
        });

        it('should return 404 if trying to update a non-existent file', async () => {
            const res = await request(app)
                .put(`/pictures/${randomUUID()}`)
                .attach('myImage', testImagePath)
                .expect(404);
            expect(res.body).to.deep.equal({ message: 'Image not found.' });
        });

        it('should return 400 if trying to replace an image with a zip file', async () => {
            const res = await request(app)
                .put(`/pictures/${imageToUpdate.id}`)
                .attach('myImage', testZipPath)
                .expect(400);
            expect(res.body).to.deep.equal({ message: 'Only image files can be used to replace an existing image.' });
        });
    });

    // PATCH (for filename update)
    describe('PATCH /pictures/:id', () => {
        let imageToPatch;

        // Before each test, clean state and upload one image to be patched.
        beforeEach(async () => {
            await cleanTestState();
            const res = await request(app).post('/pictures').attach('myImage', testImagePath);
            imageToPatch = res.body.successful[0];
        });

        it('should update the display name of an existing image', async () => {
            const newName = 'renamed_image.png';
            const res = await request(app)
                .patch(`/pictures/${imageToPatch.id}`)
                .send({ newFilename: newName })
                .expect(200);
            expect(res.body.message).to.equal('Filename updated successfully.');

            // Verify the change and the timestamp in the database
            const getRes = await request(app).get('/pictures');
            const renamedImage = getRes.body.find(img => img.id === imageToPatch.id);
            expect(renamedImage.displayName).to.equal(newName);
            expect(renamedImage.lastModifiedAt).to.not.equal(renamedImage.uploadedAt);
        });

        it('should return 409 if the new display name already exists', async () => {
            // Upload a second image to create a naming conflict.
            await request(app).post('/pictures').attach('myImage', testImagePath);
            await request(app)
                .patch(`/pictures/${imageToPatch.id}`) // Try to rename our file to the one that now exists
                .send({ newFilename: 'valid-image.png' })
                .expect(409, { message: 'A file with this display name already exists.' });
        });
    });

    // DELETE
    describe('DELETE /pictures', () => {
        let imageToDeleteId;
        let physicalFilename;

        // Before each test, clean state and upload one image to be deleted.
        beforeEach(async () => {
            await cleanTestState();
            const res = await request(app).post('/pictures').attach('myImage', largeImagePath);
            const imageToDelete = res.body.successful[0];
            imageToDeleteId = imageToDelete.id;
            const db = JSON.parse(await fs.readFile(path.join(__dirname, '../database.json'), 'utf-8'));
            physicalFilename = db[imageToDeleteId].physicalFilename;
        });

        it('should successfully delete an image from the database and the file system', async () => {
            await request(app).delete('/pictures').send({ ids: [imageToDeleteId] }).expect(200);

            // Verify the physical file is gone from disk
            try {
                await fs.access(path.join(uploadsDir, physicalFilename));
                throw new Error('File was not deleted from the file system.');
            } catch (err) {         
                expect(err.code).to.equal('ENOENT');
            }
        });
    });
  });
});
