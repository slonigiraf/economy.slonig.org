import 'dotenv/config';
import express, { Request, Response } from 'express';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import { hexToU8a } from '@polkadot/util';
import mysql from 'mysql2/promise';
import { fetch } from 'undici';
import { VALIDITY, getAirdropAmount, getDiplomaPrice, getWarrantyAmount, hashRecipient, maskIp } from './utils';
import BN from 'bn.js';
import '@polkadot/api-augment'; // Don't remove: https://github.com/polkadot-js/api/releases/tag/v7.0.1
import cors from 'cors';


const app = express();
app.use(cors());
const PORT: number = parseInt(process.env.PORT || '3000', 10);

// Initialize MySQL connection
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 30,
  queueLimit: 0,
});

// Initialize connection to Polkadot node
let api: ApiPromise | null = null;
let currentNonce: BN | null = null;
const nonceQueue: (() => Promise<void>)[] = [];

async function getPolkadotApi(): Promise<ApiPromise> {
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

async function getNextNonce(senderAddress: string): Promise<BN> {
  return new Promise((resolve) => {
    nonceQueue.push(async () => {
      const api = await getPolkadotApi();
      if (currentNonce === null) {
        currentNonce = await api.rpc.system.accountNextIndex(senderAddress);
      } else {
        currentNonce = currentNonce.add(new BN(1));
      }
      resolve(currentNonce);
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

interface GeoLocationData {
  country?: string;
  countryCode?: string;
  city?: string;
  region?: string;
  regionName?: string;
  zip?: string;
  lat?: number;
  lon?: number;
  timezone?: string;
  isp?: string;
}

async function getGeolocationData(ipAddress: string): Promise<GeoLocationData | null> {
  try {
    if (ipAddress === '127.0.0.1' || ipAddress === 'localhost' || ipAddress.startsWith('192.168.') || ipAddress.startsWith('::1')) {
      return { country: 'Local', countryCode: 'LO', city: 'Local' };
    }

    const cleanIp = ipAddress.split(':')[0].split(',')[0].trim();
    const response = await fetch(`http://ip-api.com/json/${cleanIp}`);
    const data: unknown = await response.json();

    return (typeof data === 'object' && data !== null && 'status' in data && data.status === 'success') ? data as GeoLocationData : null;
  } catch (error) {
    console.error('Error fetching geolocation data:', error);
    return null;
  }
}

app.get('/airdrop/*', (req: Request, res: Response) => {
  (async () => {
    try {
      const AUTH_TOKEN = process.env.AUTH_TOKEN;
      if (!AUTH_TOKEN) {
        return res.status(500).json({ success: false, error: 'AUTH_TOKEN_NOT_SET' });
      }

      const SECRET_SEED = process.env.AIRDROP_SECRET_SEED;
      if (!SECRET_SEED) {
        return res.status(500).json({ success: false, error: 'AIRDROP_SECRET_SEED_NOT_SET' });
      }

      const auth = req.query.auth as string;
      if (auth !== AUTH_TOKEN) {
        return res.status(400).json({ success: false, error: 'WRONG_AUTH_TOKEN' });
      }

      const address = req.query.to as string;
      if (!address || address.length < 10) {
        return res.status(400).json({ success: false, error: 'INVALID_ACCOUNT' });
      }

      const ipAddress = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || 'unknown';

      const api = await getPolkadotApi();

      const connection = await pool.getConnection();

      const recipientHash = hashRecipient(address);
      const maskedIp = maskIp(ipAddress);

      const [rows] = await connection.query<any[]>(
        'SELECT amount, timestamp FROM airdrop WHERE recipient_hash = ? LIMIT 1',
        [recipientHash]
      );

      if (rows.length > 0) {
        const { amount, timestamp } = rows[0];
        const thirtySecondsAgo = Date.now() - 30 * 1000;

        if (amount > 0 || (timestamp && new Date(timestamp).getTime() > thirtySecondsAgo)) {
          connection.release();
          return res.status(400).json({ success: false, error: 'DUPLICATED_AIRDROP' });
        }
      }

      await connection.query(
        `INSERT IGNORE INTO airdrop (recipient_hash, amount, ip_address) VALUES (?, ?, ?)`,
        [recipientHash, 0, maskedIp]
      );

      const geoData = await getGeolocationData(ipAddress);
      const country = geoData?.countryCode || 'US';
      const transferAmount = getAirdropAmount(country)
      const keyring = new Keyring({ type: 'sr25519' });
      const sender = keyring.addFromSeed(hexToU8a(SECRET_SEED));

      const nonce = await getNextNonce(sender.address);

      const transfer = api.tx.balances.transfer(address, transferAmount);

      // Here is the crucial part:
      //
      // signAndSend returns a Promise that resolves to an unsubscribe function.
      // We capture it, do not "return" the res.json(...).
      //
      const unsub = await transfer.signAndSend(sender, { nonce }, async ({ status, events }) => {
        try {
          if (status.isInBlock) {
            const success = events.some(({ event }) =>
              event.section === 'system' && event.method === 'ExtrinsicSuccess'
            );

            if (success) {
              const txHash = transfer.hash.toHex();
              await connection.query(
                `UPDATE airdrop SET tx_hash = ?, amount = ?, country = ?, country_code = ?, region = ?, region_name = ?, city = ?, timezone = ? WHERE recipient_hash = ?`,
                [txHash, transferAmount.toString(), geoData?.country || null, geoData?.countryCode || null, geoData?.region || null, geoData?.regionName || null, geoData?.city || null, geoData?.timezone || null, recipientHash]
              );
              connection.release();
              res.json({ success: true, amount: transferAmount.toString() });
              return; // Now the callback returns void
            } else {
              unsub();
              res.status(500).json({ success: false, error: 'AIRDROP_NOT_ENOUGH_FUNDS' });
              return;
            }
          }
        } catch (err) {
          unsub();
          console.error('❌ Transaction error:', err);
          res.status(500).json({ success: false, error: 'TRANSACTION_FAILED' });
        }
      });

    } catch (err) {
      // If an error occurs before we get the unsub, we catch it here
      console.error('Signing error:', err);
      return res.status(500).json({ success: false, error: 'SIGNING_FAILED' });
    }
  })();
});

app.get('/prices/*', (req: Request, res: Response) => {
  (async () => {
    try {
      const ipAddress = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || 'unknown';
      const geoData = await getGeolocationData(ipAddress);
      const country = geoData?.countryCode || 'US';
      res.json({
        success: true,
        airdrop: getAirdropAmount(country).toString(),
        diploma: getDiplomaPrice(country).toString(),
        warranty: getWarrantyAmount(country).toString(),
        validity: VALIDITY.toString()
      });
    } catch (err) {
      console.error('Prices error:', err);
      return res.status(500).json({ success: false, error: 'PRICES_FAILED' });
    }
  })();
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});