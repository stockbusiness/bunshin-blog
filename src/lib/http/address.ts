/**
 * IPアドレスの到達可否判定（TASKS C-7、SPEC 14.3）。
 *
 * **ホスト名の見た目では判定できない。** `internal.example.com` が
 * `10.0.0.1` を返すこともあれば、攻撃者が自分のドメインの A レコードを
 * `127.0.0.1` に向けることもできる。**名前解決した結果のIPで判定する。**
 *
 * DBもネットワークも触らない純粋な処理。ここが SSRF 対策の中核なので、
 * 判定表を1箇所に集約してテストで固める。
 */

/** IPv4 を32ビット整数にする。形式が不正なら `null` */
export function parseIpv4(value: string): number | null {
  const parts = value.split('.');
  if (parts.length !== 4) {
    return null;
  }

  let result = 0;
  for (const part of parts) {
    // 「01」のような先頭ゼロは8進数と解釈される実装があり、判定をすり抜ける
    if (!/^\d{1,3}$/.test(part) || (part.length > 1 && part.startsWith('0'))) {
      return null;
    }
    const octet = Number(part);
    if (octet > 255) {
      return null;
    }
    result = result * 256 + octet;
  }

  return result;
}

interface Cidr {
  /** ネットワークアドレス（32ビット整数） */
  readonly base: number;
  /** プレフィックス長 */
  readonly bits: number;
  readonly reason: string;
}

function cidr(notation: string, reason: string): Cidr {
  const [address, prefix] = notation.split('/') as [string, string];
  const base = parseIpv4(address);
  if (base === null) {
    throw new Error(`CIDRの表記が不正です: ${notation}`);
  }

  return { base, bits: Number(prefix), reason };
}

/**
 * 到達を認めない IPv4 の範囲。
 *
 * SPEC 14.3 は「localhost 禁止・private IP 禁止・link-local 禁止」とする。
 * それに加え、**内部で使われうる予約範囲もまとめて塞ぐ**。
 * 個別に足すと漏れるため、公開インターネットで使われない範囲を一覧で持つ。
 */
const BLOCKED_IPV4: readonly Cidr[] = [
  cidr('0.0.0.0/8', 'このネットワーク'),
  cidr('10.0.0.0/8', 'プライベート'),
  cidr('100.64.0.0/10', 'キャリアグレードNAT'),
  cidr('127.0.0.0/8', 'ループバック'),
  cidr('169.254.0.0/16', 'リンクローカル（クラウドのメタデータを含む）'),
  cidr('172.16.0.0/12', 'プライベート'),
  cidr('192.0.0.0/24', 'IETF プロトコル割り当て'),
  cidr('192.0.2.0/24', 'ドキュメント用'),
  cidr('192.88.99.0/24', '6to4 リレー'),
  cidr('192.168.0.0/16', 'プライベート'),
  cidr('198.18.0.0/15', 'ベンチマーク用'),
  cidr('198.51.100.0/24', 'ドキュメント用'),
  cidr('203.0.113.0/24', 'ドキュメント用'),
  cidr('224.0.0.0/4', 'マルチキャスト'),
  cidr('240.0.0.0/4', '予約'),
];

function inCidr(address: number, range: Cidr): boolean {
  // 32ビットのシフトは JS では 0 シフト扱いになるため、除算で桁を落とす
  const divisor = 2 ** (32 - range.bits);

  return Math.floor(address / divisor) === Math.floor(range.base / divisor);
}

/** IPv6 を16バイトへ展開する。形式が不正なら `null` */
export function parseIpv6(value: string): Uint8Array | null {
  // ゾーンID（fe80::1%eth0）は判定に使わない
  const withoutZone = value.split('%')[0] ?? '';
  if (withoutZone === '' || !withoutZone.includes(':')) {
    return null;
  }

  const halves = withoutZone.split('::');
  if (halves.length > 2) {
    return null;
  }

  const expand = (part: string): number[] | null => {
    if (part === '') {
      return [];
    }

    const groups: number[] = [];
    const chunks = part.split(':');

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index] as string;

      // 末尾は IPv4 表記を取りうる（::ffff:192.0.2.1）
      if (chunk.includes('.')) {
        if (index !== chunks.length - 1) {
          return null;
        }
        const v4 = parseIpv4(chunk);
        if (v4 === null) {
          return null;
        }
        groups.push(Math.floor(v4 / 0x10000), v4 % 0x10000);
        continue;
      }

      if (!/^[0-9a-fA-F]{1,4}$/.test(chunk)) {
        return null;
      }
      groups.push(Number.parseInt(chunk, 16));
    }

    return groups;
  };

  const head = expand(halves[0] ?? '');
  const tail = halves.length === 2 ? expand(halves[1] ?? '') : [];
  if (head === null || tail === null) {
    return null;
  }

  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 0 : missing !== 0) {
    return null;
  }

  const groups = [
    ...head,
    ...Array<number>(halves.length === 2 ? missing : 0).fill(0),
    ...tail,
  ];
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = Math.floor(group / 256);
    bytes[index * 2 + 1] = group % 256;
  });

  return bytes;
}

function isIpv4Mapped(bytes: Uint8Array): boolean {
  for (let index = 0; index < 10; index += 1) {
    if (bytes[index] !== 0) {
      return false;
    }
  }

  return bytes[10] === 0xff && bytes[11] === 0xff;
}

function embeddedIpv4(bytes: Uint8Array): number {
  return (
    (bytes[12] ?? 0) * 0x1000000 +
    (bytes[13] ?? 0) * 0x10000 +
    (bytes[14] ?? 0) * 0x100 +
    (bytes[15] ?? 0)
  );
}

/** 判定の結果。塞いだ場合は理由を持つ（ログ用。クライアントへは返さない） */
export interface AddressVerdict {
  blocked: boolean;
  reason: string | undefined;
}

const ALLOWED: AddressVerdict = { blocked: false, reason: undefined };

function blocked(reason: string): AddressVerdict {
  return { blocked: true, reason };
}

/**
 * このIPへ到達してよいかを判定する。
 *
 * **判定できないものは塞ぐ。** 解釈できない表記を通すと、その表記を
 * 使って判定をすり抜けられる。
 */
export function classifyAddress(value: string): AddressVerdict {
  const trimmed = value.trim();

  const v4 = parseIpv4(trimmed);
  if (v4 !== null) {
    const range = BLOCKED_IPV4.find((item) => inCidr(v4, item));

    return range === undefined ? ALLOWED : blocked(range.reason);
  }

  const v6 = parseIpv6(trimmed);
  if (v6 === null) {
    return blocked('IPアドレスとして解釈できない');
  }

  // IPv4射影（::ffff:10.0.0.1）は IPv4 として判定する。
  // ここを見落とすと、同じ宛先に IPv6 表記で到達できてしまう
  if (isIpv4Mapped(v6)) {
    const embedded = embeddedIpv4(v6);
    const range = BLOCKED_IPV4.find((item) => inCidr(embedded, item));

    return range === undefined
      ? ALLOWED
      : blocked(`${range.reason}（IPv4射影）`);
  }

  const first = v6[0] ?? 0;
  const second = v6[1] ?? 0;

  if (v6.every((byte) => byte === 0)) {
    return blocked('未指定アドレス');
  }

  if (v6.slice(0, 15).every((byte) => byte === 0) && v6[15] === 1) {
    return blocked('ループバック');
  }

  // NAT64（64:ff9b::/96）は埋め込まれた IPv4 で判定する
  if (first === 0x00 && second === 0x64 && v6[2] === 0xff && v6[3] === 0x9b) {
    const embedded = embeddedIpv4(v6);
    const range = BLOCKED_IPV4.find((item) => inCidr(embedded, item));

    return range === undefined ? ALLOWED : blocked(`${range.reason}（NAT64）`);
  }

  if ((first & 0xfe) === 0xfc) {
    return blocked('ユニークローカル');
  }

  if (first === 0xfe && (second & 0xc0) === 0x80) {
    return blocked('リンクローカル');
  }

  if (first === 0xff) {
    return blocked('マルチキャスト');
  }

  if (first === 0x20 && second === 0x01 && v6[2] === 0x0d && v6[3] === 0xb8) {
    return blocked('ドキュメント用');
  }

  return ALLOWED;
}

/** 到達を認めないIPかどうか */
export function isBlockedAddress(value: string): boolean {
  return classifyAddress(value).blocked;
}
