import { generateWallet, signPayload } from './crypto.mjs';
import { PROTOCOL_VERSION } from './consensus.mjs';

export { generateWallet };

/** Build and sign a v2 transfer. Amounts and fees are atomic units (BigInt or canonical string). */
export function createTransfer({ seed, from, chainId, to, amount, fee, nonce, memo = '' }) {
  const payload = {
    version: PROTOCOL_VERSION, chainId, from, to,
    amount: amount.toString(), fee: fee.toString(), nonce, memo,
  };
  const { publicKey, signature } = signPayload(payload, seed);
  return { payload, publicKey, signature };
}
