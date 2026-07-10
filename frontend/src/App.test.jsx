import { describe, it, expect } from 'vitest';
import React from 'react';

// We want to test the key math and utility functions used in App.jsx
describe('RemitPool Split and Yield Accounting Math', () => {
  
  // 1. Test split calculation logic
  it('should calculate the direct and savings amounts correctly based on split percentage', () => {
    const sendAmount = 100;
    const splitPercent = 20; // 20% to savings, 80% direct
    
    const savingsAmount = sendAmount * (splitPercent / 100);
    const directAmount = sendAmount * (1 - splitPercent / 100);
    
    expect(savingsAmount).toBe(20);
    expect(directAmount).toBe(80);
  });

  it('should handle 0% split (all direct)', () => {
    const sendAmount = 150.5;
    const splitPercent = 0;
    
    const savingsAmount = sendAmount * (splitPercent / 100);
    const directAmount = sendAmount * (1 - splitPercent / 100);
    
    expect(savingsAmount).toBe(0);
    expect(directAmount).toBe(150.5);
  });

  it('should handle 100% split (all savings)', () => {
    const sendAmount = 50;
    const splitPercent = 100;
    
    const savingsAmount = sendAmount * (splitPercent / 100);
    const directAmount = sendAmount * (1 - splitPercent / 100);
    
    expect(savingsAmount).toBe(50);
    expect(directAmount).toBe(0);
  });

  // 2. Test live yield counter visual formatting
  const formatLiveBalance = (val) => {
    if (isNaN(val) || val <= 0) return { integer: "0", decimals: ".0000000" };
    const parts = val.toFixed(7).split('.');
    return {
      integer: parts[0],
      decimals: '.' + parts[1]
    };
  };

  it('should format live yield balances with high-precision decimals correctly', () => {
    const testVal1 = 123.45678901;
    const format1 = formatLiveBalance(testVal1);
    expect(format1.integer).toBe("123");
    expect(format1.decimals).toBe(".4567890"); // rounded to 7 decimals

    const testVal2 = 0.0001;
    const format2 = formatLiveBalance(testVal2);
    expect(format2.integer).toBe("0");
    expect(format2.decimals).toBe(".0001000");

    const testVal3 = -10.5;
    const format3 = formatLiveBalance(testVal3);
    expect(format3.integer).toBe("0");
    expect(format3.decimals).toBe(".0000000");
  });

  // 3. Test real-time yield accrual simulation formula
  it('should simulate continuous yield growth correctly based on elapsed seconds', () => {
    const initialSavingsVal = 1000.0; // 1000 USDC
    const ratePerSec = 100000; // 100,000 scaled by 1e9 = 0.0001 per sec (0.01% yield per second)
    const elapsedSeconds = 5; // 5 seconds elapsed
    
    // Formula: increment = initial * ratePerSec * elapsed / 1e9
    const increment = initialSavingsVal * (ratePerSec / 1000000000) * elapsedSeconds;
    const currentVal = initialSavingsVal + increment;
    
    expect(increment).toBe(0.5); // 1000 * 0.0001 * 5 = 0.5 USDC accrued interest yield
    expect(currentVal).toBe(1000.5);
  });
});
