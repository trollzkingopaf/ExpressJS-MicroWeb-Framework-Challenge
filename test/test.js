const request = require('supertest');
const chai = require('chai');
const expect = chai.expect;
const app = require('../story2.1.js'); // Import the app
const path = require('path');
const { execFile } = require('child_process');
const fs = require('fs/promises');
const JSZip = require('jszip');
const { randomUUID } = require('crypto');
const Seven = require('node-7z');
const path7za = require('7zip-bin').path7za;

const uploadsDir = path.join(__dirname, '../uploads');
const tmpDir = path.join(uploadsDir, 'tmp');
const testImagePath = path.join(__dirname, 'test_image.png');
const testNonImagePath = path.join(__dirname, 'not_an_image.txt');
const testZipPath = path.join(__dirname, 'test_images.zip');
const test7zPath = path.join(__dirname, 'test_images.7z');
const testConflictZipPath = path.join(__dirname, 'test_conflict_images.zip');

describe('Microweb Image Framework', () => {

  const temp7zSourceDir = path.join(__dirname, 'temp_7z_source');

  // Before all tests, ensure the uploads directory is clean and exists.
  before(async function() {
    this.timeout(10000); // Increase timeout for setup which involves creating archives.
    try {
      await fs.unlink(path.join(__dirname, '../database.json')).catch(() => {});
      await fs.rm(uploadsDir, { recursive: true, force: true });
      await fs.mkdir(tmpDir, { recursive: true });

      // Create a test zip file for upload tests
      const zip = new JSZip();
      const imgData = await fs.readFile(testImagePath);
      const txtData = await fs.readFile(testNonImagePath);
      zip.file('test_image.png', imgData); // Will conflict with the first test's upload
      zip.file('another_image.png', imgData);
      zip.file('folder/nested_image.png', imgData); // To test basename extraction
      zip.file('folder/another_image.png', imgData); // To test intra-archive conflicts
      zip.file('should_be_ignored.txt', txtData);
      
      const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
      await fs.writeFile(testZipPath, zipBuffer);

      // Create a test 7z file for upload tests, mirroring the zip file's contents
      await fs.rm(temp7zSourceDir, { recursive: true, force: true }); // Clean up from previous runs
      await fs.mkdir(temp7zSourceDir, { recursive: true });
      await fs.copyFile(testImagePath, path.join(temp7zSourceDir, 'test_image.png'));
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

  // After all tests are done, close the server and clean up the uploads directory.
  after(async () => {
    try {
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

  // --- Unit Tests for Page Rendering ---
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

  // --- Integration Tests for API CRUD Operations ---
  describe('API CRUD Operations (/pictures)', () => {
    let uploadedImageId; // Will store the ID of the first uploaded image

    // CREATE
    describe('POST /pictures', () => {
      it('should upload an image successfully and return its new ID and metadata', async () => {
        const res = await request(app)
          .post('/pictures')
          .attach('myImage', testImagePath)
          .expect(200);
            expect(res.body.message).to.equal('1 image file(s) were added.');
            expect(res.body.successful).to.be.an('array').with.lengthOf(1);
            const uploadedImage = res.body.successful[0];
            expect(uploadedImage).to.have.property('id');
            expect(uploadedImage.displayName).to.equal('test_image.png');
            uploadedImageId = uploadedImage.id; // Save for later tests
      });

      it('should return a 207 conflict status if a file with the same display name already exists', async () => {
        // The file 'test_image.png' was uploaded in the previous test
        const res = await request(app)
          .post('/pictures')
          .attach('myImage', testImagePath)
          .expect(207);
            expect(res.body.message).to.include('1 file(s) have naming conflicts.');
            expect(res.body.conflicts).to.be.an('array').with.lengthOf(1);
            expect(res.body.conflicts[0].originalFilename).to.equal('test_image.png');
            expect(res.body.conflicts[0].existingId).to.equal(uploadedImageId);
            // Clean up the temp file to not leave garbage
            await fs.unlink(res.body.conflicts[0].tempPath);
      });

      it('should reject a non-image file', async function() {
        // Increase timeout and add proper error handling
        this.timeout(10000);

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

      // --- New tests for ZIP functionality ---
      describe('with ZIP file', () => {
        // Clean up images from zip before this suite runs to ensure a clean slate
        before(async () => {
            await fs.unlink(path.join(uploadsDir, 'another_image.png')).catch(()=>{});
            await fs.unlink(path.join(uploadsDir, 'nested_image.png')).catch(()=>{});
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
        // This hook cleans up the state left by the previous ZIP test suite,
        // ensuring this suite runs with a predictable starting state.
        before(async function() {
            const dbPath = path.join(__dirname, '../database.json');
            try {
                const data = await fs.readFile(dbPath, 'utf-8');
                const db = JSON.parse(data);
                
                const idsToDelete = [];
                const filesToDelete = [];

                for (const id in db) {
                    if (db[id].displayName === 'another_image.png' || db[id].displayName === 'nested_image.png') {
                        idsToDelete.push(id);
                        filesToDelete.push(path.join(uploadsDir, db[id].physicalFilename));
                    }
                }

                if (idsToDelete.length > 0) {
                    idsToDelete.forEach(id => delete db[id]);
                    await fs.writeFile(dbPath, JSON.stringify(db, null, 2));
                    await Promise.all(filesToDelete.map(f => fs.unlink(f).catch(() => {})));
                }
            } catch (err) {
                // Ignore errors (e.g., DB file not found), as it means the state is already clean.
            }
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

    // --- New tests for Conflict Resolution ---
    describe('POST /pictures/resolve-conflict', () => {
        let conflict;

        // Before these tests, create a conflict situation
        before(async () => {
            const res = await request(app)
                .post('/pictures')
                .attach('myImage', testImagePath, 'test_image.png') // This should already exist
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
            // Create a new conflict to resolve
            const conflictRes = await request(app).post('/pictures').attach('myImage', testImagePath, 'test_image.png');
            const newConflict = conflictRes.body.conflicts[0];
            const res = await request(app)
                .post('/pictures/resolve-conflict')
                .send({
                    action: 'overwrite',
                    tempPath: newConflict.tempPath,
                    existingId: newConflict.existingId
                })
                .expect(200);
            expect(res.body.message).to.equal(`File '${newConflict.originalFilename}' was overwritten.`);
        });

        it('should resolve a conflict by skipping the new file', async () => {
            // Create a new conflict to resolve
            const conflictRes = await request(app).post('/pictures').attach('myImage', testImagePath, 'test_image.png');
            const newConflict = conflictRes.body.conflicts[0];
            const res = await request(app)
                .post('/pictures/resolve-conflict')
                .send({
                    action: 'skip',
                    tempPath: newConflict.tempPath,
                    originalFilename: newConflict.originalFilename
                })
                .expect(200);
            expect(res.body.message).to.equal(`Upload of '${newConflict.originalFilename}' was skipped.`);
            // Verify the temp file was deleted
            try {
                await fs.access(newConflict.tempPath);
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
      it('should return a list containing the uploaded image with its metadata', async () => {
        const res = await request(app)
          .get('/pictures')
          .expect(200);
            expect(res.body).to.be.an('array').and.not.be.empty;
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
        const newImagePath = path.join(__dirname, newImageName);

        before(async () => await fs.copyFile(testImagePath, newImagePath));
        after(async () => await fs.unlink(newImagePath));

        it('should replace an existing image with a new one using its ID', async () => {
            const res = await request(app)
                .put(`/pictures/${uploadedImageId}`)
                .attach('myImage', newImagePath)
                .expect(200);
            expect(res.body.message).to.equal('File updated successfully');
            expect(res.body.link).to.include(uploadedImageId);
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
                .put(`/pictures/${uploadedImageId}`)
                .attach('myImage', testZipPath)
                .expect(400);
            expect(res.body).to.deep.equal({ message: 'Only image files can be used to replace an existing image.' });
        });
    });

    // PATCH (for filename update)
    describe('PATCH /pictures/:id', () => {
        it('should update the display name of an existing image', async () => {
            const newName = 'renamed_image.png';
            const res = await request(app)
                .patch(`/pictures/${uploadedImageId}`)
                .send({ newFilename: newName })
                .expect(200);
            expect(res.body.message).to.equal('Filename updated successfully.');
        });

        it('should return 409 if the new display name already exists', async () => {
            // First, re-upload the original test image so we have a conflict
            await request(app).post('/pictures').attach('myImage', testImagePath);
            await request(app)
                .patch(`/pictures/${uploadedImageId}`) // Try to rename our file to the one that now exists
                .send({ newFilename: 'test_image.png' })
                .expect(409, { message: 'A file with this display name already exists.' });
        });
    });

    // DELETE
    describe('DELETE /pictures', () => {
      it('should delete the uploaded image', async function() {
        this.timeout(5000);
        const res = await request(app)
          .delete(`/pictures`)
          .send({ ids: [uploadedImageId] })
          .expect(200);
        expect(res.body).to.have.property('message', '1 image(s) deleted successfully.');
      });

      it('should return a 200 with 0 deleted if trying to delete a non-existent file', async function() {
        this.timeout(5000);
        const res = await request(app)
          .delete(`/pictures`) // Trying to delete it again
          .send({ ids: [uploadedImageId] })
          .expect(200);
        expect(res.body).to.deep.equal({ message: '0 image(s) deleted successfully.' });
      });
    });
  });
});
