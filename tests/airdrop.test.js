const request = require('supertest');
const { Keyring } = require('@polkadot/keyring');
const { hexToU8a } = require('@polkadot/util');
const mysql = require('mysql2/promise');
require('dotenv').config();

const BASE_URL = process.env.TEST_URL;
const { cryptoWaitReady } = require('@polkadot/util-crypto');

async function generateTestAddresses(count) {
    await cryptoWaitReady(); // Ensure WASM is initialized

    const keyring = new Keyring({ type: 'sr25519' });
    return Array.from({ length: count }, (_, i) => keyring.addFromUri(`//test${i}`).address);
}

describe('Airdrop API Tests', () => {
    let testAddresses = [];

    beforeAll(async () => {
        testAddresses = await generateTestAddresses(10);
    });

    test('Receive 9 different airdrops on 9 different addresses', async () => {
        for (let i = 1; i < testAddresses.length; i++) {
            const response = await request(BASE_URL).get(`/?to=${testAddresses[i]}`);
            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(response.body.amount).toBe(10_000_000_000_000);
        }
    }, 30000);

    test('Receive an airdrop on an address but fail to get the duplicated one', async () => {
        const address = testAddresses[0];
        const response1 = await request(BASE_URL).get(`/?to=${address}`);
        expect(response1.status).toBe(200);
        expect(response1.body.success).toBe(true);

        const response2 = await request(BASE_URL).get(`/?to=${address}`);
        expect(response2.status).toBe(400);
        expect(response2.body.success).toBe(false);
        expect(response2.body.error).toBe('DUPLICATED_AIRDROP');
    }, 30000);
});