const mongoose = require('mongoose');
const bcrypt = require('bcryptjs'); // or bcrypt, let's try bcrypt

mongoose.connect('mongodb://127.0.0.1:27017/rfqtool')
  .then(async () => {
    const db = mongoose.connection.db;
    const bcryptLocal = require('bcrypt') || require('bcryptjs');
    const hashedPassword = await bcryptLocal.hash('admin123', 10);
    await db.collection('users').updateOne(
      { email: 'archana.n@sunserk.com' },
      { $set: { password: hashedPassword } }
    );
    console.log('Password reset to admin123');
    process.exit(0);
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
