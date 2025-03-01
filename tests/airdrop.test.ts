import request from 'supertest';
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { ApiPromise, WsProvider } from '@polkadot/api';
import dotenv from 'dotenv';
import type { AccountInfo } from '@polkadot/types/interfaces';
import '@polkadot/api-augment'; // Don't remove: https://github.com/polkadot-js/api/releases/tag/v7.0.1

dotenv.config();

const BASE_URL = process.env.TEST_URL as string;
const WS_PROVIDER = process.env.WS_PROVIDER || 'wss://ws-parachain-1.slonigiraf.org';

async function getPolkadotApi(): Promise<ApiPromise> {
    const provider = new WsProvider(WS_PROVIDER);
    return await ApiPromise.create({ provider });
}

async function getBalance(api: ApiPromise, address: string): Promise<string> {
    const accountInfo = await api.query.system.account(address) as unknown as AccountInfo;
    return accountInfo.data.free.toString();
}

async function generateTestAddresses(count: number): Promise<string[]> {
    await cryptoWaitReady();
    const keyring = new Keyring({ type: 'sr25519' });
    return Array.from({ length: count }, (_, i) => keyring.addFromUri(`//test${i}`).address);
}

describe('Airdrop API Tests', () => {
    let testAddresses: string[] = [];
    let api: ApiPromise;

    beforeAll(async () => {
        api = await getPolkadotApi();
        testAddresses = await generateTestAddresses(10);
    });

    afterAll(async () => {
        await api.disconnect();
    });

    test('Receive an airdrop and validate balance increase', async () => {
        const address = testAddresses[0];

        // Fetch initial balance
        const initialBalance = await getBalance(api, address);

        // Request airdrop
        const response = await request(BASE_URL).get(`/airdrop/?to=${address}`);
        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);

        const expectedIncrease = response.body.amount; // Amount in JSON response

        // Wait a few seconds to ensure blockchain finalization
        await new Promise(resolve => setTimeout(resolve, 10000));

        // Fetch new balance
        const finalBalance = await getBalance(api, address);

        // Validate balance increase
        expect(BigInt(finalBalance)).toBe(BigInt(initialBalance) + BigInt(expectedIncrease));
    }, 60000);

    test('Check multiple airdrops and validate balances', async () => {
        const initialBalances = await Promise.all(testAddresses.slice(1).map(address => getBalance(api, address)));

        // Request multiple airdrops
        const responses = await Promise.all(
            testAddresses.slice(1).map(address => request(BASE_URL).get(`/airdrop/?to=${address}`))
        );

        responses.forEach(response => {
            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
        });

        const expectedIncreases = responses.map(response => BigInt(response.body.amount));

        // Wait a few seconds for transactions to finalize
        await new Promise(resolve => setTimeout(resolve, 10000));

        const finalBalances = await Promise.all(testAddresses.slice(1).map(address => getBalance(api, address)));

        // Validate each balance increase
        finalBalances.forEach((finalBalance, index) => {
            expect(BigInt(finalBalance)).toBe(BigInt(initialBalances[index]) + expectedIncreases[index]);
        });
    }, 60000);
});