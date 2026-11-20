"""aes.py —— 极简 AES-128（CBC + NoPadding）纯 Python 实现。

用途：在没有 cryptography、也没有 openssl 命令的机器上（例如 Windows 开发机、
精简容器）仍能解上游封面。逻辑与 `openssl enc -aes-128-cbc -nopad -K -iv`
完全一致，已用 FIPS-197 标准向量自测（python aes.py）。

性能：纯 Python 约 60~150 KB/s，封面 100~200KB 需要 1~3 秒；网关有磁盘缓存，
所以只影响首张图。生产建议装 cryptography（快 1000 倍），本文件只作兜底。
"""

from __future__ import annotations

SBOX = [
    0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
    0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
    0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
    0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
    0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
    0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
    0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
    0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
    0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
    0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
    0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
    0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
    0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
    0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
    0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
    0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
]
INV_SBOX = [0] * 256
for _i, _v in enumerate(SBOX):
    INV_SBOX[_v] = _i
RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1B, 0x36]


def _mul(a: int, b: int) -> int:
    p = 0
    for _ in range(8):
        if b & 1:
            p ^= a
        hi = a & 0x80
        a = (a << 1) & 0xFF
        if hi:
            a ^= 0x1B
        b >>= 1
    return p & 0xFF


_MUL2 = [_mul(i, 2) for i in range(256)]
_MUL3 = [_mul(i, 3) for i in range(256)]
_MUL9 = [_mul(i, 9) for i in range(256)]
_MUL11 = [_mul(i, 11) for i in range(256)]
_MUL13 = [_mul(i, 13) for i in range(256)]
_MUL14 = [_mul(i, 14) for i in range(256)]


def expand_key(key: bytes) -> list[list[int]]:
    if len(key) != 16:
        raise ValueError("只支持 AES-128（16 字节密钥）")
    w = [list(key[i:i + 4]) for i in range(0, 16, 4)]
    for i in range(4, 44):
        t = list(w[i - 1])
        if i % 4 == 0:
            t = t[1:] + t[:1]
            t = [SBOX[b] for b in t]
            t[0] ^= RCON[i // 4 - 1]
        w.append([w[i - 4][j] ^ t[j] for j in range(4)])
    return [sum(w[4 * r:4 * r + 4], []) for r in range(11)]


def _add_key(s: list[int], rk: list[int]) -> None:
    for i in range(16):
        s[i] ^= rk[i]


def _encrypt_block(s: list[int], rks: list[list[int]]) -> list[int]:
    _add_key(s, rks[0])
    for rnd in range(1, 11):
        s = [SBOX[b] for b in s]
        s = [s[r + 4 * ((c + r) % 4)] for c in range(4) for r in range(4)]
        if rnd != 10:
            ns = [0] * 16
            for c in range(4):
                a0, a1, a2, a3 = s[4 * c:4 * c + 4]
                ns[4 * c + 0] = _MUL2[a0] ^ _MUL3[a1] ^ a2 ^ a3
                ns[4 * c + 1] = a0 ^ _MUL2[a1] ^ _MUL3[a2] ^ a3
                ns[4 * c + 2] = a0 ^ a1 ^ _MUL2[a2] ^ _MUL3[a3]
                ns[4 * c + 3] = _MUL3[a0] ^ a1 ^ a2 ^ _MUL2[a3]
            s = ns
        _add_key(s, rks[rnd])
    return s


def _decrypt_block(s: list[int], rks: list[list[int]]) -> list[int]:
    _add_key(s, rks[10])
    for rnd in range(9, -1, -1):
        # InvShiftRows
        s = [s[r + 4 * ((c - r) % 4)] for c in range(4) for r in range(4)]
        s = [INV_SBOX[b] for b in s]
        _add_key(s, rks[rnd])
        if rnd != 0:
            ns = [0] * 16
            for c in range(4):
                a0, a1, a2, a3 = s[4 * c:4 * c + 4]
                ns[4 * c + 0] = _MUL14[a0] ^ _MUL11[a1] ^ _MUL13[a2] ^ _MUL9[a3]
                ns[4 * c + 1] = _MUL9[a0] ^ _MUL14[a1] ^ _MUL11[a2] ^ _MUL13[a3]
                ns[4 * c + 2] = _MUL13[a0] ^ _MUL9[a1] ^ _MUL14[a2] ^ _MUL11[a3]
                ns[4 * c + 3] = _MUL11[a0] ^ _MUL13[a1] ^ _MUL9[a2] ^ _MUL14[a3]
            s = ns
    return s


def cbc_encrypt(key: bytes, iv: bytes, data: bytes) -> bytes:
    rks = expand_key(key)
    prev = list(iv)
    out = bytearray()
    for i in range(0, len(data), 16):
        blk = [data[i + j] ^ prev[j] for j in range(16)]
        enc = _encrypt_block(blk, rks)
        out += bytes(enc)
        prev = enc
    return bytes(out)


def cbc_decrypt(key: bytes, iv: bytes, data: bytes) -> bytes:
    rks = expand_key(key)
    prev = list(iv)
    out = bytearray()
    for i in range(0, len(data), 16):
        blk = list(data[i:i + 16])
        dec = _decrypt_block(blk, rks)
        out += bytes(a ^ b for a, b in zip(dec, prev))
        prev = blk
    return bytes(out)


if __name__ == "__main__":
    # FIPS-197 附录 B / C.1 标准向量
    k = bytes(range(16))
    pt = bytes.fromhex("00112233445566778899aabbccddeeff")
    ct = bytes.fromhex("69c4e0d86a7b0430d8cdb78070b4c55a")
    got = cbc_encrypt(k, b"\x00" * 16, pt)
    back = cbc_decrypt(k, b"\x00" * 16, ct)
    print("encrypt:", got.hex(), "OK" if got == ct else "FAIL")
    print("decrypt:", back.hex(), "OK" if back == pt else "FAIL")
    raise SystemExit(0 if got == ct and back == pt else 1)
