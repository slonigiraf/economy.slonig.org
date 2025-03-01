import dotenv from 'dotenv';
import { getDiplomaPrice, getAirdropAmount } from '../src/utils';
import BN from 'bn.js';
dotenv.config();

describe('Functions Tests', () => {
    test('Calculate diploma price', async () => {
        const country = 'US';
        const airdropAmount = getAirdropAmount(country);
        const diplomaPrice = getDiplomaPrice(country);
        const maxDiplomaCount = airdropAmount.divRound(diplomaPrice);
        expect(airdropAmount.toString()).toBe('10116000000000000');
        expect(diplomaPrice.toString()).toBe('512000000000000');
        expect(maxDiplomaCount.toNumber()).toBeGreaterThan(19);
    });
});