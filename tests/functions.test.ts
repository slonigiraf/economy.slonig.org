import dotenv from 'dotenv';
import { getAirdropAmount } from '../src/utils';
dotenv.config();

describe('Functions Tests', () => {
    test('Calculate transfer amount based on country', async () => {
        expect(getAirdropAmount('US').toString()).toBe('10116000000000000');
    });
});