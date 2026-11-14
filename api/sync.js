// Vercel serverless function: one-document cloud sync for the Eat the Frog tracker.
// Env vars (set in Vercel → Settings → Environment Variables):
//   MONGODB_URI  – MongoDB Atlas connection string
//   SYNC_KEY     – long random secret; the app must send it in the X-Sync-Key header
//   MONGODB_DB   – optional, defaults to "frogtracker"
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

let clientPromise;
async function collections() {
  if (global.__frogTestCollections) return global.__frogTestCollections; // used by local tests only
  if (!clientPromise) clientPromise = new MongoClient(process.env.MONGODB_URI).connect();
  const db = (await clientPromise).db(process.env.MONGODB_DB || 'frogtracker');
  return { state: db.collection('state'), backups: db.collection('backups') };
}

function keyOk(given) {
  const want = process.env.SYNC_KEY || '';
  if (!given || !want) return false;
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Sync-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!process.env.SYNC_KEY || (!process.env.MONGODB_URI && !global.__frogTestCollections)) {
    return res.status(500).json({ error: 'Server not configured: set MONGODB_URI and SYNC_KEY in Vercel' });
  }
  if (!keyOk(req.headers['x-sync-key'])) return res.status(401).json({ error: 'Wrong sync key' });

  try {
    const { state, backups } = await collections();
    const current = await state.findOne({ _id: 'main' });

    if (req.method === 'GET') {
      return res.status(200).json({ data: current ? current.data : null, updatedAt: current ? current.updatedAt : 0 });
    }

    if (req.method === 'PUT') {
      let body = req.body;
      if (typeof body === 'string') body = JSON.parse(body);
      if (!body || typeof body.data !== 'object' || body.data === null || typeof body.updatedAt !== 'number') {
        return res.status(400).json({ error: 'Body must be {data: object, updatedAt: number}' });
      }
      // Last-write-wins: refuse writes from a device holding older data, hand it the newer copy.
      if (current && current.updatedAt > body.updatedAt && !body.force) {
        return res.status(409).json({ error: 'Server has newer data', data: current.data, updatedAt: current.updatedAt });
      }
      await state.updateOne({ _id: 'main' }, { $set: { data: body.data, updatedAt: body.updatedAt } }, { upsert: true });
      // One backup per day (latest write of that day wins).
      const day = new Date().toISOString().slice(0, 10);
      await backups.updateOne({ _id: day }, { $set: { data: body.data, updatedAt: body.updatedAt } }, { upsert: true });
      return res.status(200).json({ ok: true, updatedAt: body.updatedAt });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: 'Sync failed: ' + e.message });
  }
};
