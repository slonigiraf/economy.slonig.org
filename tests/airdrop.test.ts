import request from 'supertest';
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { ApiPromise, WsProvider } from '@polkadot/api';
import dotenv from 'dotenv';
import type { AccountInfo } from '@polkadot/types/interfaces';
import '@polkadot/api-augment'; // Don't remove: https://github.com/polkadot-js/api/releases/tag/v7.0.1
import BN from 'bn.js';
import { precision } from '../src/utils';

dotenv.config();

const BASE_URL = process.env.TEST_URL as string;
const WS_PROVIDER = process.env.WS_PROVIDER || 'wss://ws-parachain-1.slonigiraf.org';
const AIRDROP_SECRET_SEED = process.env.AIRDROP_SECRET_SEED as string;

async function getPolkadotApi(): Promise<ApiPromise> {
    const provider = new WsProvider(WS_PROVIDER);
    return await ApiPromise.create({ provider });
}

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
export async function transferFundsBack(
    api: ApiPromise,
    senderSeed: string,
    testAccounts: { address: string; uri: string }[]
): Promise<void> {
    await cryptoWaitReady();

    const keyring = new Keyring({ type: 'sr25519' });
    // This is your main "destination" (the account you want to gather funds into)
    const recipient = keyring.addFromUri(senderSeed);

    // Grab the Existential Deposit constant from the chain
    const existentialDeposit: BN = api.consts.balances.existentialDeposit;

    const transferPromises = testAccounts.map(async ({ address, uri }) => {
        try {
            // Read current on-chain balance
            const balance = new BN(await getBalance(api, address));
            console.log('address: ', address)
            console.log('balance: ', balance)

            // Check if there's enough to bother transferring
            if (balance.gt(precision)) {
                const amountToTransfer = balance.sub(precision);

                // Prepare the sender keypair (IMPORTANT: we must use the secret URI, not just the address)
                const sender = keyring.addFromUri(uri);

                // Fetch current nonce for this sender
                const nonce = await api.rpc.system.accountNextIndex(sender.address);

                // Return a promise so we can await all at once (Promise.all)
                return new Promise<void>((resolve, reject) => {
                    api.tx.balances
                        .transfer(recipient.address, amountToTransfer)
                        .signAndSend(sender, { nonce }, (result) => {
                            const { status, events = [] } = result;

                            // When included in a block
                            if (status.isInBlock) {
                                console.log(`✅ [${address}] Included in block: ${status.asInBlock.toHex()}`);
                            }
                            // When finalized
                            if (status.isFinalized) {
                                console.log(`✅ [${address}] Finalized in block: ${status.asFinalized.toHex()}`);

                                // Detect any on-chain ExtrinsicFailed events
                                const extrinsicFailedEvents = events.filter(({ event }) =>
                                    api.events.system.ExtrinsicFailed.is(event)
                                );

                                if (extrinsicFailedEvents.length > 0) {
                                    console.error(`❌ [${address}] ExtrinsicFailed with error(s):`);
                                    extrinsicFailedEvents.forEach(({ event: { data } }) => {
                                        const [dispatchError] = data;
                                        console.error(`   → ${dispatchError.toString()}`);
                                    });

                                    return reject(new Error(`ExtrinsicFailed for ${address}`));
                                }

                                console.log(`✅ [${address}] Transfer succeeded!`);
                                resolve();
                            }
                        })
                        .catch((error) => {
                            // Catch errors in the submission (e.g., cannot broadcast)
                            console.error(`❌ [${address}] signAndSend error:`, error);
                            reject(error);
                        });
                });
            }
        } catch (error) {
            console.error(`❌ [${address}] Error during transfer:`, error);
            // We don't throw here, because we don't want the rest to fail
            // But you could "throw error" if you want to fail the entire process
        }
    });

    // Wait for all transfers to finish (or fail)
    await Promise.all(transferPromises);
}

describe('Airdrop API Tests', () => {
    let testAccounts: { address: string; uri: string }[] = [];
    let api: ApiPromise;

    beforeAll(async () => {
        api = await getPolkadotApi();
        testAccounts = await generateTestAccounts(2);
    });

    afterAll(async () => {
        console.log('Transferring funds back to sender...');
        try {
            await transferFundsBack(api, AIRDROP_SECRET_SEED, testAccounts);
        } catch (error) {
            console.error('Error transferring funds:', error);
        }
        await api.disconnect();
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
    }, 30000);

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
    }, 30000);
});