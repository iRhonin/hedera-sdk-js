import * as nacl from "tweetnacl";
import * as crypto from "crypto";
import { Ed25519PublicKey } from "./Ed25519PublicKey";
import { Mnemonic } from "./Mnemonic";
import { decodeHex, deriveChildKey, ed25519PrivKeyPrefix, encodeHex, pbkdf2, randomBytes } from "./util";
import { RawKeyPair } from "./RawKeyPair";
import { createKeystore, loadKeystore } from "./Keystore";
import { BadKeyError } from "../errors/BadKeyError";

export class Ed25519PrivateKey {
    public readonly publicKey: Ed25519PublicKey;

    // NOT A STABLE API
    public readonly _keyData: Uint8Array;
    private _asStringRaw?: string;
    private _chainCode?: Uint8Array;

    private constructor({ privateKey, publicKey }: RawKeyPair) {
        if (privateKey.length !== nacl.sign.secretKeyLength) {
            throw new BadKeyError();
        }

        this._keyData = privateKey;
        this.publicKey = Ed25519PublicKey.fromBytes(publicKey);
    }

    /**
     * Recover a private key from its raw bytes form.
     *
     * This key will _not_ support child key derivation.
     */
    public static fromBytes(bytes: Uint8Array): Ed25519PrivateKey {
        // this check is necessary because Jest breaks the prototype chain of Uint8Array
        // noinspection SuspiciousTypeOfGuard
        const bytesArray = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
        let keypair;

        switch (bytes.length) {
            case 32:
                // fromSeed takes the private key bytes and calculates the public key
                keypair = nacl.sign.keyPair.fromSeed(bytesArray);
                break;
            case 64:
                // priv + pub key pair
                keypair = nacl.sign.keyPair.fromSecretKey(bytesArray);
                break;
            default:
                throw new BadKeyError();
        }

        const { secretKey: privateKey, publicKey } = keypair;

        return new Ed25519PrivateKey({ privateKey, publicKey });
    }

    /**
     * Recover a key from a hex-encoded string.
     *
     * This key will _not_ support child key derivation.
     */
    public static fromString(keyStr: string): Ed25519PrivateKey {
        switch (keyStr.length) {
            case 64: // lone private key
            case 128: { // private key + public key
                const newKey = Ed25519PrivateKey.fromBytes(decodeHex(keyStr));
                newKey._asStringRaw = keyStr;
                return newKey;
            }
            case 96:
                if (keyStr.startsWith(ed25519PrivKeyPrefix)) {
                    const rawStr = keyStr.slice(32);
                    const newKey = Ed25519PrivateKey.fromBytes(decodeHex(rawStr));
                    newKey._asStringRaw = rawStr;
                    return newKey;
                }
                break;
            default:
        }
        throw new BadKeyError();
    }

    /**
     * Recover a key from a 24-word mnemonic.
     *
     * There is no corresponding `toMnemonic()` as the mnemonic cannot be recovered from the key.
     *
     * Instead, you must generate a mnemonic and a corresponding key in that order with
     * `generateMnemonic()`.
     *
     * This accepts mnemonics generated by the Android and iOS mobile wallets.
     *
     * This key *will* support deriving child keys with `.derive()`.
     *
     * @param mnemonic the mnemonic, either as a string separated by spaces or as a 24-element array
     * @param passphrase the passphrase to protect the private key with
     *
     * @link generateMnemonic
     */
    public static async fromMnemonic(
        mnemonic: Mnemonic,
        passphrase: string
    ): Promise<Ed25519PrivateKey> {
        const input = mnemonic.toString();
        const salt = `mnemonic${passphrase}`;
        const seed = await pbkdf2(input, salt, 2048, 64, "sha512");

        const hmac = crypto.createHmac("sha512", "ed25519 seed");
        hmac.update(seed);

        const digest = hmac.digest();

        let keyBytes: Uint8Array = digest.subarray(0, 32);
        let chainCode: Uint8Array = digest.subarray(32);

        for (const index of [ 44, 3030, 0, 0 ]) {
            ({ keyBytes, chainCode } = deriveChildKey(keyBytes, chainCode, index));
        }

        const key = Ed25519PrivateKey.fromBytes(keyBytes);
        key._chainCode = chainCode;
        return key;
    }

    /**
     * Recover a private key from a keystore blob previously created by `.createKeystore()`.
     *
     * This key will _not_ support child key derivation.
     *
     * @param keystore the keystore blob
     * @param passphrase the passphrase used to create the keystore
     * @throws KeyMismatchError if the passphrase is incorrect or the hash fails to validate
     * @link createKeystore
     */
    public static async fromKeystore(
        keystore: Uint8Array,
        passphrase: string
    ): Promise<Ed25519PrivateKey> {
        return new Ed25519PrivateKey(await loadKeystore(keystore, passphrase));
    }

    /**
     * Generate a new, cryptographically random private key.
     *
     * This key will _not_ support child key derivation.
     */
    public static async generate(): Promise<Ed25519PrivateKey> {
        return this.fromBytes(await randomBytes(32));
    }

    /**
     * Derive a new private key at the given wallet index.
     *
     * Only currently supported for keys created with `fromMnemonic()`; other keys will throw
     * an error.
     *
     * You can check if a key supports derivation with `.supportsDerivation`
     */
    public derive(index: number): Ed25519PrivateKey {
        if (this._chainCode == null) {
            throw new Error("this Ed25519 private key does not support key derivation");
        }

        const {
            keyBytes,
            chainCode
        } = deriveChildKey(this._keyData.subarray(0, 32), this._chainCode, index);

        const key = Ed25519PrivateKey.fromBytes(keyBytes);
        key._chainCode = chainCode;

        return key;
    }

    /** Check if this private key supports deriving child keys */
    public get supportsDerivation(): boolean {
        return this._chainCode != null;
    }

    public toBytes(): Uint8Array {
        // copy the bytes so they can't be modified accidentally
        // only copy the private key portion since that's what we're expecting on the other end
        return this._keyData.slice(0, 32);
    }

    public toString(raw = false): string {
        if (this._asStringRaw == null) {
            // only encode the private portion of the private key
            this._asStringRaw = encodeHex(this._keyData.subarray(0, 32));
        }

        return (raw ? "" : ed25519PrivKeyPrefix) + this._asStringRaw;
    }

    /**
     * Create a keystore blob with a given passphrase.
     *
     * The key can be recovered later with `fromKeystore()`.
     *
     * Note that this will not retain the ancillary data used for deriving child keys,
     * thus `.derive()` on the restored key will throw even if this instance supports derivation.
     *
     * @link fromKeystore
     */
    public toKeystore(passphrase: string): Promise<Uint8Array> {
        return createKeystore(this._keyData, passphrase);
    }
}
