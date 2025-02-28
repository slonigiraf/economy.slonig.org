require('dotenv').config();
const express = require('express');
const { ApiPromise, WsProvider } = require('@polkadot/api');
const { Keyring } = require('@polkadot/keyring');
const { hexToU8a } = require('@polkadot/util');
const mysql = require('mysql2/promise');
const fetch = require('node-fetch');
const { gdpPerCapita } = require('./constants.js');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize MySQL connection
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 30,
  queueLimit: 0,
});

// Initialize connection to Polkadot node
let api = null;
let currentNonce = null;
const nonceQueue = [];

async function getPolkadotApi() {
  if (!api) {
    const provider = new WsProvider('wss://ws-parachain-1.slonigiraf.org');
    api = await ApiPromise.create({ provider });

    provider.on('disconnected', async () => {
      console.error('❌ Disconnected from Slon node. Reconnecting...');
      setTimeout(getPolkadotApi, 5000);
    });

    provider.on('error', (error) => {
      console.error('❌ WebSocket Error:', error);
    });

    provider.on('connected', () => {
      console.log('✅ Reconnected to Slon node!');
    });
  }
  return api;
}

// Function to get and increment nonce synchronously
async function getNextNonce(senderAddress) {
  return new Promise(async (resolve) => {
    nonceQueue.push(async () => {
      const api = await getPolkadotApi();

      if (currentNonce === null) {
        // First time fetching nonce
        const chainNonce = await api.rpc.system.accountNextIndex(senderAddress);
        currentNonce = chainNonce.toNumber();
      } else {
        // Increment nonce manually
        currentNonce += 1;
      }

      resolve(currentNonce);

      // Remove the processed function from queue
      nonceQueue.shift();
      if (nonceQueue.length > 0) {
        nonceQueue[0]();
      }
    });

    if (nonceQueue.length === 1) {
      nonceQueue[0]();
    }
  });
}

// Initialize API and fetch initial nonce
(async () => {
  await getPolkadotApi();
  const keyring = new Keyring({ type: 'sr25519' });
  const sender = keyring.addFromSeed(hexToU8a(process.env.AIRDROP_SECRET_SEED));
  await getNextNonce(sender.address);
})();

// Function to get geolocation data from IP
async function getGeolocationData(ipAddress) {
  try {
    if (ipAddress === '127.0.0.1' || ipAddress === 'localhost' || ipAddress.startsWith('192.168.') || ipAddress.startsWith('::1')) {
      return { country: 'Local', countryCode: 'LO', city: 'Local' };
    }

    const cleanIp = ipAddress.split(':')[0].split(',')[0].trim();
    const response = await fetch(`http://ip-api.com/json/${cleanIp}`);
    const data = await response.json();

    return data.status === 'success' ? data : null;
  } catch (error) {
    console.error('Error fetching geolocation data:', error);
    return null;
  }
}

// Function to send a transaction
async function sendTransaction(api, sender, nonce, address, amount) {
  try {
    const transfer = api.tx.balances.transfer(address, amount);

    console.log(`🔄 Sending transaction with nonce ${nonce}...`);
    await transfer.signAndSend(sender, { nonce });

    console.log(`✅ Transaction sent successfully!`);
    return transfer.hash.toHex();
  } catch (error) {
    console.error(`❌ Transaction failed: ${error.message}`);
    throw error;
  }
}

app.get('*', async (req, res) => {
  try {
    const address = req.query.to;
    const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';

    if (!address || address.length < 10) {
      return res.status(400).json({ success: false, error: 'INVALID_ACCOUNT' });
    }

    const api = await getPolkadotApi();
    const secretSeed = process.env.AIRDROP_SECRET_SEED;
    if (!secretSeed) {
      return res.status(500).json({ success: false, error: 'AIRDROP_SECRET_SEED_NOT_SET' });
    }

    const connection = await pool.getConnection();

    const [existingTransaction] = await connection.query(
      'SELECT amount, timestamp FROM airdrop WHERE recipient = ? LIMIT 1',
      [address]
    );

    if (existingTransaction.length > 0) {
      const { amount, timestamp } = existingTransaction[0];
      const thirtySecondsAgo = Date.now() - 30 * 1000;

      if (amount > 0 || (timestamp && new Date(timestamp).getTime() > thirtySecondsAgo)) {
        connection.release();
        return res.status(400).json({ success: false, error: 'DUPLICATED_AIRDROP' });
      }
    }

    // Prevent race conditions
    await connection.query(
      `INSERT IGNORE INTO airdrop (recipient, amount, ip_address) 
       VALUES (?, ?, ?)`,
      [address, 0, ipAddress]
    );

    // Fetch geolocation data
    const geoData = await getGeolocationData(ipAddress);
    const country = geoData?.countryCode || US;
    const transferAmount = BigInt(Math.round(0.15355908906 * gdpPerCapita[country])) * BigInt(1_000_000_000_000);
    const keyring = new Keyring({ type: 'sr25519' });
    const sender = keyring.addFromSeed(hexToU8a(secretSeed));
    const nonce = await getNextNonce(sender.address);

    const txHash = await sendTransaction(api, sender, nonce, address, transferAmount);

    // Update the airdrop record with tx hash & geo data
    await connection.query(
      `UPDATE airdrop 
       SET tx_hash = ?, amount = ?, country = ?, country_code = ?, region = ?, region_name = ?, city = ?, zip = ?, latitude = ?, longitude = ?, timezone = ?, isp = ? 
       WHERE recipient = ?`,
      [
        txHash,
        transferAmount.toString(),
        geoData?.country || null,
        geoData?.countryCode || null,
        geoData?.region || null,
        geoData?.regionName || null,
        geoData?.city || null,
        geoData?.zip || null,
        geoData?.lat || null,
        geoData?.lon || null,
        geoData?.timezone || null,
        geoData?.isp || null,
        address
      ]
    );

    connection.release();
    return res.json({ success: true, amount: transferAmount.toString() });

  } catch (error) {
    console.error('❌ Error processing request:', error);
    return res.status(500).json({ success: false, error: 'AIRDROP_ERROR' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});