const { MongoClient } = require('mongodb');

// Configuration
const LOCAL_URI = 'mongodb://localhost:27017';
const LOCAL_DB_NAME = 'rfqtool';
const ATLAS_URI = 'mongodb+srv://user:123@cluster0.xawpc.mongodb.net/?appName=Cluster0';
const ATLAS_DB_NAME = 'rfqtool';

async function migrate() {
  const localClient = new MongoClient(LOCAL_URI);
  const atlasClient = new MongoClient(ATLAS_URI);

  try {
    console.log('Connecting to Local MongoDB...');
    await localClient.connect();
    console.log('✅ Connected to Local MongoDB');

    console.log('Connecting to Atlas MongoDB...');
    await atlasClient.connect();
    console.log('✅ Connected to Atlas MongoDB');

    const localDb = localClient.db(LOCAL_DB_NAME);
    const atlasDb = atlasClient.db(ATLAS_DB_NAME);

    const collections = await localDb.listCollections().toArray();
    console.log(`Found ${collections.length} collections to migrate.`);

    for (const collectionInfo of collections) {
      const collectionName = collectionInfo.name;
      console.log(`Migrating collection: ${collectionName}...`);

      const data = await localDb.collection(collectionName).find({}).toArray();
      
      if (data.length > 0) {
        // Drop existing collection on Atlas if it exists (optional, but cleaner for full migration)
        try {
          await atlasDb.collection(collectionName).drop();
          console.log(`  - Dropped existing ${collectionName} on Atlas`);
        } catch (e) {
          // Ignore error if collection doesn't exist
        }

        await atlasDb.collection(collectionName).insertMany(data);
        console.log(`  ✅ Migrated ${data.length} documents.`);
      } else {
        console.log(`  - Collection is empty, skipping.`);
      }
    }

    console.log('\n🎉 Migration completed successfully!');
  } catch (err) {
    console.error('\n❌ Migration failed:');
    console.error(err.message);
    if (err.message.includes('ECONNREFUSED')) {
      console.error('\nTIP: Make sure your local MongoDB service is running on port 27017.');
    }
  } finally {
    await localClient.close();
    await atlasClient.close();
  }
}

migrate();
