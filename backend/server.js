require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bs58 = require('bs58');
const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL
} = require('@solana/web3.js');

// ---- env ----
const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) {
  console.error("RPC_URL not set. Put your Helius mainnet endpoint in backend/.env");
  process.exit(1);
}
const PRICE_LAMPORTS = Number(process.env.PRICE_LAMPORTS || 20_000_000); // 0.02 SOL
const PORT = Number(process.env.PORT || 8787);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const HOUSE_SECRET_KEY = process.env.HOUSE_SECRET_KEY || "";

function loadHouseKeypair() {
  if (!HOUSE_SECRET_KEY) {
    throw new Error("HOUSE_SECRET_KEY is empty. Put base58 or JSON array of secret key in .env (server-only).");
  }
  try {
    // base58 string?
    if (HOUSE_SECRET_KEY.trim().startsWith("[") && HOUSE_SECRET_KEY.trim().endsWith("]")) {
      // JSON array
      const arr = JSON.parse(HOUSE_SECRET_KEY.trim());
      const sk = Uint8Array.from(arr);
      return Keypair.fromSecretKey(sk);
    } else {
      const decoded = bs58.decode(HOUSE_SECRET_KEY.trim());
      return Keypair.fromSecretKey(decoded);
    }
  } catch (e) {
    throw new Error("Failed to parse HOUSE_SECRET_KEY. Provide base58 string (bs58) OR JSON array (Uint8Array).");
  }
}

let houseKp;
try {
  houseKp = loadHouseKeypair();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(cors({ origin: CORS_ORIGIN }));
const conn = new Connection(RPC_URL, { commitment: 'confirmed' });

app.get('/health', async (req, res) => {
  try {
    const bh = await conn.getLatestBlockhash();
    res.json({ ok: true, network: 'mainnet-beta', house: houseKp.publicKey.toBase58(), blockhash: bh.blockhash });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Prepare bet: returns unsigned tx for player to sign (transfer PRICE from player -> house)
app.post('/bet/prepare', async (req, res) => {
  try {
    const { playerPubkey } = req.body || {};
    if (!playerPubkey) return res.status(400).json({ error: "playerPubkey required" });
    const player = new PublicKey(playerPubkey);

    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('finalized');

    const ix = SystemProgram.transfer({
      fromPubkey: player,
      toPubkey: houseKp.publicKey,
      lamports: PRICE_LAMPORTS
    });

    const tx = new Transaction();
    tx.recentBlockhash = blockhash;
    tx.feePayer = player;
    tx.add(ix);

    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    res.json({
      txBase64: serialized.toString('base64'),
      blockhash,
      lastValidBlockHeight,
      house: houseKp.publicKey.toBase58(),
      priceLamports: PRICE_LAMPORTS
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Settle bet: verify incoming payment; if OK -> 50/50 -> pay 2x if win
app.post('/bet/settle', async (req, res) => {
  try {
    const { signature, playerPubkey } = req.body || {};
    if (!signature || !playerPubkey) return res.status(400).json({ error: "signature and playerPubkey are required" });

    // Confirm incoming tx
    const tx = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    if (!tx) return res.status(400).json({ error: "Transaction not found/confirmed" });

    // Verify transfer PRICE from player -> house
    const player = new PublicKey(playerPubkey);
    let ok = false;
    const message = tx.transaction.message;
    const accKeys = message.getAccountKeys();
    // iterate instructions
    for (const ix of message.compiledInstructions) {
      const programId = accKeys.get(ix.programIdIndex);
      if (programId && programId.toBase58() === SystemProgram.programId.toBase58()) {
        // decode data
        try {
          const { data } = ix;
          // SystemProgram.transfer instruction discriminator is 2 (u32 le)
          const ixType = data.readUInt32LE(0);
          if (ixType === 2) {
            // accounts: from, to
            const from = accKeys.get(ix.accountKeyIndexes[0]);
            const to = accKeys.get(ix.accountKeyIndexes[1]);
            // lamports
            const lamports = data.readBigUInt64LE(4);
            if (from.equals(player) && to.equals(houseKp.publicKey) && Number(lamports) === PRICE_LAMPORTS) {
              ok = true;
              break;
            }
          }
        } catch {}
      }
    }
    if (!ok) return res.status(400).json({ error: "Incoming tx does not match expected transfer" });

    // Decide win 50/50
    const win = Math.random() < 0.5;

    let payoutSig = null;
    if (win) {
      const toPubkey = player;
      const payoutIx = SystemProgram.transfer({
        fromPubkey: houseKp.publicKey,
        toPubkey,
        lamports: PRICE_LAMPORTS * 2
      });
      const { blockhash } = await conn.getLatestBlockhash('finalized');
      const payoutTx = new Transaction().add(payoutIx);
      payoutTx.recentBlockhash = blockhash;
      payoutTx.feePayer = houseKp.publicKey;
      payoutSig = await conn.sendTransaction(payoutTx, [houseKp], { skipPreflight: false });
    }

    res.json({
      ok: true,
      win,
      payoutSignature: payoutSig,
      house: houseKp.publicKey.toBase58(),
      priceLamports: PRICE_LAMPORTS
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`[backend] listening on http://localhost:${PORT}`);
  console.log(`[backend] house pubkey: ${houseKp.publicKey.toBase58()}`);
  console.log(`[backend] price: ${PRICE_LAMPORTS} lamports (${PRICE_LAMPORTS / LAMPORTS_PER_SOL} SOL)`);
});
