import dotenv from 'dotenv';
import { getDiplomaPrice, getAirdropAmount, getReimbursementPrice, precision } from '../src/utils';
import BN from 'bn.js';
dotenv.config();

describe('Functions Tests', () => {
    test('Airdrop amount calculation', async () => {
        expect(getAirdropAmount('US').toString()).toBe('10116000000000000');
    });
    test('Diploma price calculation', async () => {
        const country = 'US';
        const airdropAmount = getAirdropAmount(country);
        const diplomaPrice = getDiplomaPrice(country);
        const maxDiplomaCount = airdropAmount.divRound(diplomaPrice);
        expect(airdropAmount.toString()).toBe('10116000000000000');
        expect(diplomaPrice.toString()).toBe('512000000000000');
        expect(maxDiplomaCount.toNumber()).toBeGreaterThan(19);
    });
    test('Reimbursement price calculation', async () => {
        const country = 'US';
        const reimbursementPrice = getReimbursementPrice(country).div(precision).toNumber();
        const diplomaPrice = getDiplomaPrice(country).div(precision).toNumber();
        expect(reimbursementPrice/diplomaPrice).toBeCloseTo(1.2,2);
    });
});