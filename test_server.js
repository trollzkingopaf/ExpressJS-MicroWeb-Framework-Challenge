
const express = require('express');
const app = express();
const port = 3001;

app.post('/upload', (req, res) => {
  console.log('test_server.js: Received a request to /upload');
  res.status(200).send('Success from test_server.js');
});

app.listen(port, () => console.log(`Test server started on port ${port}`));
