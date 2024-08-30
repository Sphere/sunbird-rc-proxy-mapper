declare module 'long' {
    export class Long {
        constructor(low?: number, high?: number, unsigned?: boolean);
        static fromInt(value: number, unsigned?: boolean): Long;
        static fromValue(value: Long | number | string | { low: number; high: number; unsigned: boolean }): Long;
        static fromBits(lowBits: number, highBits: number, unsigned?: boolean): Long;
        static fromString(str: string, unsigned?: boolean | { unsigned: boolean }, radix?: number): Long;
        static fromNumber(value: number, unsigned?: boolean): Long;
        toInt(): number;
        toNumber(): number;
        toString(radix?: number): string;
        toBytesLE(): Uint8Array;
        toBytesBE(): Uint8Array;
        toBytes(): Uint8Array;
        equals(other: Long | number | string): boolean;
        compare(other: Long | number | string): number;
        isZero(): boolean;
        isNegative(): boolean;
        isPositive(): boolean;
        negate(): Long;
        add(addend: Long | number | string): Long;
        subtract(subtrahend: Long | number | string): Long;
        multiply(multiplier: Long | number | string): Long;
        divide(divisor: Long | number | string): Long;
        modulo(divisor: Long | number | string): Long;
        and(other: Long | number | string): Long;
        or(other: Long | number | string): Long;
        xor(other: Long | number | string): Long;
        shiftLeft(numBits: number): Long;
        shiftRight(numBits: number): Long;
        shiftRightUnsigned(numBits: number): Long;
        toSigned(): Long;
        toUnsigned(): Long;
        length(): number;
    }
}
