// upload.js — This middleware handles incoming file uploads.
// It acts as a security guard — only allowing Excel files through,
// and temporarily storing them in memory while they are processed.
// Think of it as the receiving dock at a warehouse.

const multer = require('multer');

// "memoryStorage" means the uploaded file is held in your server's
// RAM temporarily instead of being saved to disk.
// This is fine for Excel files since we process them immediately
// and then discard them — we only need the data inside, not the file itself.
const storage = multer.memoryStorage();

// This function runs before every upload.
// It checks whether the file being uploaded is actually an Excel file.
// If not, it rejects the upload with a clear error message.
const fileFilter = (req, file, cb) => {
  // These are the official file type codes for Excel files.
  // .xlsx files use the first type, older .xls files use the second.
  const allowedTypes = [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
    'application/vnd.ms-excel', // .xls
  ];

  if (allowedTypes.includes(file.mimetype)) {
    // File is an Excel file — allow it through
    cb(null, true);
  } else {
    // File is not an Excel file — reject it with a helpful error
    cb(new Error('Only Excel files (.xlsx or .xls) are allowed'), false);
  }
};

// Combine the storage method and file filter into one upload handler.
// Also set a size limit of 10MB — large enough for any parts list,
// small enough to prevent someone accidentally uploading a huge file.
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB in bytes (10 × 1024 × 1024)
  },
});

module.exports = upload;