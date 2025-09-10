
const request = require('supertest');
const chai = require('chai');
const expect = chai.expect;
const server = require('../Story1.js'); // Import the server
const path = require('path');
const fs = require('fs/promises');

const uploadsDir = path.join(__dirname, '../uploads');
const testImagePath = path.join(__dirname, 'test_image.png');
const testNonImagePath = path.join(__dirname, 'not_an_image.txt');

describe('Microweb Image Framework', () => {

  // Before all tests, ensure the uploads directory is clean and exists.
  before(async () => {
    try {
      await fs.rm(uploadsDir, { recursive: true, force: true });
      await fs.mkdir(uploadsDir, { recursive: true });
    } catch (error) {
      console.error("Could not set up uploads directory before tests:", error);
    }
  });

  // After all tests are done, close the server and clean up the uploads directory.
  after(async () => {
    server.close();
    try {
      await fs.rm(uploadsDir, { recursive: true, force: true });
    } catch (error) {
      console.error("Could not clean up uploads directory after tests:", error);
    }
  });

  // --- Unit Tests for Page Rendering ---
  describe('Page Rendering', () => {
    it('GET / should render the welcome page', (done) => {
      request(server)
        .get('/')
        .expect(200)
        .end((err, res) => {
          expect(res.text).to.include('Welcome - Microweb Image Framework');
          expect(res.text).to.include("Let's Go");
          done();
        });
    });

    it('GET /gallery should render the main application page', (done) => {
      request(server)
        .get('/gallery')
        .expect(200)
        .end((err, res) => {
          expect(res.text).to.include('Microweb Image Framework');
          expect(res.text).to.include('Image Gallery');
          done();
        });
    });
  });

  // --- Integration Tests for API CRUD Operations ---
  describe('API CRUD Operations (/pictures)', () => {
    let uploadedFilename = 'test_image.png'; // We know the filename because we save it as original

    // CREATE
    describe('POST /pictures', () => {
      it('should upload an image successfully and retain its original name', (done) => {
        request(server)
          .post('/pictures')
          .attach('myImage', testImagePath)
          .expect(200)
          .end((err, res) => {
            expect(res.body).to.have.property('message', 'File uploaded successfully');
            expect(res.body).to.have.property('link').that.includes(uploadedFilename);
            done();
          });
      });

      it('should reject a non-image file', (done) => {
        request(server)
          .post('/pictures')
          .attach('myImage', testNonImagePath)
          .expect(400)
          .end((err, res) => {
            expect(res.body).to.have.property('message', 'Unsupported file format');
            done();
          });
      });

      it('should return an error if no file is selected', (done) => {
        request(server)
          .post('/pictures')
          .expect(400)
          .end((err, res) => {
            expect(res.body).to.have.property('message', 'Error: No File Selected!');
            done();
          });
      });
    });

    // READ
    describe('GET /pictures', () => {
      it('should return a list containing the uploaded image with its metadata', (done) => {
        request(server)
          .get('/pictures')
          .expect(200)
          .end((err, res) => {
            expect(res.body).to.be.an('array').that.is.not.empty;
            const image = res.body.find(img => img.filename === uploadedFilename);
            expect(image).to.exist;
            expect(image).to.have.property('link');
            expect(image).to.have.property('type');
            expect(image).to.have.property('width');
            expect(image).to.have.property('height');
            done();
          });
      });
    });

    // UPDATE
    describe('PUT /pictures/:filename', () => {
        const newImageName = 'new_test_image.png';
        const newImagePath = path.join(__dirname, newImageName);

        before(async () => await fs.copyFile(testImagePath, newImagePath));
        after(async () => await fs.unlink(newImagePath));

        it('should replace an existing image with a new one', (done) => {
            request(server)
                .put(`/pictures/${uploadedFilename}`)
                .attach('myImage', newImagePath)
                .expect(200)
                .end((err, res) => {
                    expect(res.body.message).to.equal('File updated successfully');
                    expect(res.body.link).to.include(newImageName);
                    uploadedFilename = newImageName; // Update filename for the DELETE test
                    done();
                });
        });

        it('should return 404 if trying to update a non-existent file', (done) => {
            request(server)
                .put('/pictures/nonexistent.png')
                .attach('myImage', testImagePath)
                .expect(404, { message: 'File to update not found.' }, done);
        });
    });

    // PATCH (for filename update)
    describe('PATCH /pictures/:filename', () => {
        it('should update the filename of an existing image', (done) => {
            const newName = 'renamed_image.png';
            request(server)
                .patch(`/pictures/${uploadedFilename}`)
                .send({ newFilename: newName })
                .expect(200)
                .end((err, res) => {
                    expect(res.body.message).to.equal('Filename updated successfully.');
                    uploadedFilename = newName; // Update for subsequent tests
                    done();
                });
        });

        it('should return 409 if the new filename already exists', (done) => {
            // First, re-upload the original test image so we have a conflict
            request(server).post('/pictures').attach('myImage', testImagePath).end(() => {
                request(server)
                    .patch(`/pictures/${uploadedFilename}`) // Try to rename our file to the one that now exists
                    .send({ newFilename: 'test_image.png' })
                    .expect(409, { message: 'A file with this name already exists.' }, done);
            });
        });
    });

    // DELETE
    describe('DELETE /pictures/:filename', () => {
      it('should delete the uploaded image', (done) => {
        request(server)
          .delete(`/pictures/${uploadedFilename}`)
          .expect(200)
          .end((err, res) => {
            expect(res.body).to.have.property('message', 'File deleted successfully.');
            done();
          });
      });

      it('should return 404 if trying to delete a non-existent file', (done) => {
        request(server)
          .delete(`/pictures/${uploadedFilename}`) // Trying to delete it again
          .expect(404, { message: 'File not found.' }, done);
      });
    });
  });
});
