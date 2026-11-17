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

// Fields never shown without the key.
const PRIVATE_FIELDS = ['handoffContext'];
function publicView(data) {
  const copy = { ...data };
  PRIVATE_FIELDS.forEach(f => delete copy[f]);
  return copy;
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
  const authed = keyOk(req.headers['x-sync-key']);
  // Owner's choice: reading AND writing are open to anyone with the URL.
  // Without the key, private fields are hidden on read and preserved on write.
  // Safety net: one backup per day in the `backups` collection.

  try {
    const { state, backups } = await collections();
    const current = await state.findOne({ _id: 'main' });

    if (req.method === 'GET') {
      let data = current ? current.data : null;
      if (data && !authed) data = publicView(data);
      return res.status(200).json({ data, updatedAt: current ? current.updatedAt : 0, readOnly: !authed });
    }

    if (req.method === 'PUT') {
      let body = req.body;
      if (typeof body === 'string') body = JSON.parse(body);
      if (!body || typeof body.data !== 'object' || body.data === null || typeof body.updatedAt !== 'number') {
        return res.status(400).json({ error: 'Body must be {data: object, updatedAt: number}' });
      }
      // Last-write-wins: refuse writes from a device holding older data, hand it the newer copy.
      // Reject writes from a device that didn't start from the latest cloud copy (or holds older data).
      const stale = current && ((typeof body.base === 'number' && body.base !== current.updatedAt) || current.updatedAt > body.updatedAt);
      if (stale && !body.force) {
        return res.status(409).json({ error: 'Server has newer data', data: current.data, updatedAt: current.updatedAt });
      }
      if (!authed && current && current.data) PRIVATE_FIELDS.forEach(f => { if (f in current.data) body.data[f] = current.data[f]; else delete body.data[f]; });
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

module.exports.collections = collections;
module.exports.publicView = publicView;
