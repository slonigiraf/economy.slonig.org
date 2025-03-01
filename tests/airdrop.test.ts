import request from 'supertest';
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { ApiPromise, WsProvider } from '@polkadot/api';
import dotenv from 'dotenv';
import type { AccountInfo } from '@polkadot/types/interfaces';
import '@polkadot/api-augment'; // Don't remove: https://github.com/polkadot-js/api/releases/tag/v7.0.1
import BN from 'bn.js';
import { oneSlon } from '../src/utils';
import { KeyringPair } from '@polkadot/keyring/types';

dotenv.config();

const testTimeout = 30_000;
const wsProviderDisconnectTime = 30_000;
jest.setTimeout(testTimeout + wsProviderDisconnectTime);

const BASE_URL = process.env.TEST_URL as string;
const WS_PROVIDER = process.env.WS_PROVIDER || 'wss://ws-parachain-1.slonigiraf.org';
const AIRDROP_SECRET_SEED = process.env.AIRDROP_SECRET_SEED as string;

async function getBalance(api: ApiPromise, address: string): Promise<string> {
    const accountInfo = await api.query.system.account(address) as unknown as AccountInfo;
    return accountInfo.data.free.toString();
}

async function generateTestAccounts(count: number) {
    await cryptoWaitReady();
    const keyring = new Keyring({ type: 'sr25519' });

    const accounts = Array.from({ length: count }, (_, i) => {
        const pair = keyring.addFromUri(`//test${i}`);
        return {
            address: pair.address,
            uri: `//test${i}`,  // store the secret so we can sign from it later
        };
    });

    return accounts;
}
/**
 * Send funds and wait for finalization, unsubscribing along the way.
 */
async function transferAndFinalize(
    api: ApiPromise,
    from: KeyringPair,
    to: string,
    amount: BN
): Promise<void> {
    return new Promise(async (resolve, reject) => {
        try {
            // signAndSend can return an unsubscribe callback
            const unsub = await api.tx.balances
                .transfer(to, amount)
                .signAndSend(from, (result) => {
                    // If the transaction fails, reject
                    if (result.isError) {
                        unsub();
                        return reject(new Error('Transaction failed'));
                    }

                    // If the extrinsic is in a block or finalized, we're good
                    if (result.status.isInBlock || result.status.isFinalized) {
                        unsub(); // unsub is crucial to avoid open handles
                        resolve();
                    }
                });
        } catch (err) {
            reject(err);
        }
    });
}
export async function transferFundsBack(
    api: ApiPromise,
    airdropSeed: string,
    testAccounts: { address: string; uri: string }[]
): Promise<void> {
    await cryptoWaitReady();
    const keyring = new Keyring({ type: 'sr25519' });

    // This is your main "destination" (the account you want to gather funds into)
    const recipient = keyring.addFromUri(airdropSeed);

    await Promise.all(
        testAccounts.map(async (testAccount) => {
            const balance = new BN(await getBalance(api, testAccount.address));
            // Only transfer if there's something above the dust/1 Slon
            if (balance.gt(oneSlon)) {
                const sender = keyring.addFromUri(testAccount.uri);
                // Use the new helper function
                await transferAndFinalize(api, sender, recipient.address, balance.sub(oneSlon));
            }
        })
    );
}


describe('Airdrop API Tests', () => {
    let testAccounts: { address: string; uri: string }[] = [];
    const provider = new WsProvider(WS_PROVIDER);
    let api: ApiPromise;

    beforeAll(async () => {
        api = await ApiPromise.create({ provider });
        testAccounts = await generateTestAccounts(10);
    });

    afterAll(async () => {
        try {
            await transferFundsBack(api, AIRDROP_SECRET_SEED, testAccounts);
        } catch (error) {
            console.error('Error transferring funds:', error);
        }
        await api.disconnect();
        provider.disconnect();
        await new Promise((resolve) => setTimeout(resolve, 100));
    });

    test('Receive an airdrop and validate balance increase', async () => {
        const address = testAccounts[0].address;

        // Fetch initial balance
        const initialBalance = await getBalance(api, address);

        // Request airdrop
        const response = await request(BASE_URL).get(`/airdrop/?to=${address}`);
        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);

        const expectedIncrease = response.body.amount; // Amount in JSON response

        // Fetch new balance
        const finalBalance = await getBalance(api, address);

        // Validate balance increase
        expect(BigInt(finalBalance)).toBe(BigInt(initialBalance) + BigInt(expectedIncrease));
    }, testTimeout);

    test('Check multiple airdrops and validate balances', async () => {
        const initialBalances = await Promise.all(testAccounts.slice(1).map(account => getBalance(api, account.address)));

        // Request multiple airdrops
        const responses = await Promise.all(
            testAccounts.slice(1).map(account => request(BASE_URL).get(`/airdrop/?to=${account.address}`))
        );

        responses.forEach(response => {
            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
        });

        const expectedIncreases = responses.map(response => BigInt(response.body.amount));

        const finalBalances = await Promise.all(testAccounts.slice(1).map(account => getBalance(api, account.address)));

        // Validate each balance increase
        finalBalances.forEach((finalBalance, index) => {
            expect(BigInt(finalBalance)).toBe(BigInt(initialBalances[index]) + expectedIncreases[index]);
        });
    }, testTimeout);
});