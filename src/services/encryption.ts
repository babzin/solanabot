import crypto from 'crypto';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { env } from '../config/env.js';

const ALGORITHM = 'aes-256-gcm';

export interface EncryptedData {
  ciphertext: string;
  iv: string;
  tag: string;
}

export interface GeneratedWallet {
  publicKey: string;
  privateKeyBase58: string;
  encrypted: EncryptedData;
}

/**
 * Validates and parses a raw private key string (Base58 or JSON array) into a Solana Keypair
 */
export function parseKeypair(rawSecret: string): Keypair {
  const trimmed = rawSecret.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const arr = JSON.parse(trimmed);
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  const decoded = bs58.decode(trimmed);
  return Keypair.fromSecretKey(decoded);
}

/**
 * Checks whether a given string is a valid Solana private key (Base58 or JSON array)
 */
export function isValidPrivateKey(rawSecret: string): boolean {
  try {
    const kp = parseKeypair(rawSecret);
    return Boolean(kp && kp.publicKey);
  } catch {
    return false;
  }
}

/**
 * Encrypts a raw private key using AES-256-GCM authenticated encryption
 */
export function encryptPrivateKey(rawSecret: string): EncryptedData {
  const masterKey = Buffer.from(env.ENCRYPTION_MASTER_KEY, 'hex');
  const iv = crypto.randomBytes(12); // Standard 12-byte IV for GCM
  const cipher = crypto.createCipheriv(ALGORITHM, masterKey, iv);

  let encrypted = cipher.update(rawSecret.trim(), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');

  return {
    ciphertext: encrypted,
    iv: iv.toString('hex'),
    tag,
  };
}

/**
 * Decrypts ciphertext with IV and Tag into a live Solana Keypair for transaction signing
 */
export function decryptUserKeypair(ciphertext: string, ivHex: string, tagHex: string): Keypair {
  const masterKey = Buffer.from(env.ENCRYPTION_MASTER_KEY, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, masterKey, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));

  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return parseKeypair(decrypted);
}

/**
 * Generates a brand-new dedicated burner Keypair on Solana and encrypts it immediately
 */
export function generateBurnerWallet(): GeneratedWallet {
  const kp = Keypair.generate();
  const privateKeyBase58 = bs58.encode(kp.secretKey);
  const encrypted = encryptPrivateKey(privateKeyBase58);

  return {
    publicKey: kp.publicKey.toBase58(),
    privateKeyBase58,
    encrypted,
  };
}

