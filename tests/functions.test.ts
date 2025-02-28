import dotenv from 'dotenv';
import { getTransferAmount } from '../src/utils';
dotenv.config();

describe('Functions Tests', () => {
    test('Calculate transfer amount based on country', async () => {
        expect(getTransferAmount('US').toString()).toBe('10116000000000000');
    });
});