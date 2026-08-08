import { describe, expect, it } from 'vitest';
import {
  classifyAddress,
  isBlockedAddress,
  parseIpv4,
  parseIpv6,
} from '@/lib/http';

/**
 * IPアドレスの到達可否判定（TASKS C-7、SPEC 14.3）。
 *
 * **ここが SSRF 対策の中核。** 判定を1つ落とすと、その範囲へ到達できる。
 * 表記のゆれ（先頭ゼロ・IPv4射影・NAT64）でのすり抜けも確かめる。
 */

describe('parseIpv4', () => {
  it.each([
    ['0.0.0.0', 0],
    ['127.0.0.1', 2130706433],
    ['255.255.255.255', 4294967295],
    ['192.168.1.1', 3232235777],
  ])('%s を数値にする', (value, expected) => {
    expect(parseIpv4(value)).toBe(expected);
  });

  it.each([
    ['オクテットが多い', '1.2.3.4.5'],
    ['オクテットが足りない', '1.2.3'],
    ['範囲外', '256.0.0.1'],
    ['空', ''],
    ['文字が混ざる', '1.2.3.a'],
    ['IPv6', '::1'],
  ])('読み取れないものは null（%s）', (_label, value) => {
    expect(parseIpv4(value)).toBeNull();
  });

  // 「010」を8進数と解釈する実装があり、判定と接続で食い違う
  it.each(['010.0.0.1', '127.0.0.01', '0127.0.0.1'])(
    '先頭ゼロつきは受け付けない（%s）',
    (value) => {
      expect(parseIpv4(value)).toBeNull();
    },
  );
});

describe('parseIpv6', () => {
  it('省略なしを読める', () => {
    const bytes = parseIpv6('2001:0db8:0000:0000:0000:0000:0000:0001');

    expect(bytes).not.toBeNull();
    expect(bytes?.[0]).toBe(0x20);
    expect(bytes?.[15]).toBe(1);
  });

  it(':: の省略を展開できる', () => {
    expect(parseIpv6('::1')?.[15]).toBe(1);
    expect(parseIpv6('fe80::')?.[0]).toBe(0xfe);
    expect(parseIpv6('::')?.every((byte) => byte === 0)).toBe(true);
  });

  it('末尾のIPv4表記を読める', () => {
    const bytes = parseIpv6('::ffff:127.0.0.1');

    expect(bytes?.[10]).toBe(0xff);
    expect(bytes?.[12]).toBe(127);
    expect(bytes?.[15]).toBe(1);
  });

  it('ゾーンIDを無視する', () => {
    expect(parseIpv6('fe80::1%eth0')?.[0]).toBe(0xfe);
  });

  it.each([
    [':: が2回', '1::2::3'],
    ['グループが多い', '1:2:3:4:5:6:7:8:9'],
    ['グループが足りない', '1:2:3:4:5:6:7'],
    ['16進でない', 'gggg::1'],
    ['IPv4', '127.0.0.1'],
    ['空', ''],
  ])('読み取れないものは null（%s）', (_label, value) => {
    expect(parseIpv6(value)).toBeNull();
  });
});

describe('classifyAddress（IPv4）', () => {
  it.each([
    ['ループバック', '127.0.0.1'],
    ['ループバック（範囲全体）', '127.255.255.254'],
    ['プライベート 10/8', '10.0.0.1'],
    ['プライベート 172.16/12', '172.16.0.1'],
    ['プライベート 172.31 まで', '172.31.255.254'],
    ['プライベート 192.168/16', '192.168.1.1'],
    ['リンクローカル', '169.254.0.1'],
    ['クラウドのメタデータ', '169.254.169.254'],
    ['このネットワーク', '0.0.0.0'],
    ['キャリアグレードNAT', '100.64.0.1'],
    ['ベンチマーク用', '198.18.0.1'],
    ['マルチキャスト', '224.0.0.1'],
    ['予約', '240.0.0.1'],
    ['ブロードキャスト', '255.255.255.255'],
  ])('塞ぐ（%s）', (_label, address) => {
    expect(isBlockedAddress(address)).toBe(true);
    expect(classifyAddress(address).reason).toBeDefined();
  });

  it.each([
    ['一般的な公開IP', '93.184.216.34'],
    ['172.15 はプライベートではない', '172.15.255.254'],
    ['172.32 はプライベートではない', '172.32.0.1'],
    ['11/8 はプライベートではない', '11.0.0.1'],
    ['126 はループバックではない', '126.255.255.255'],
    ['128 はループバックではない', '128.0.0.1'],
    ['100.63 はCGNATではない', '100.63.255.255'],
    ['100.128 はCGNATではない', '100.128.0.1'],
  ])('通す（%s）', (_label, address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe('classifyAddress（IPv6）', () => {
  it.each([
    ['ループバック', '::1'],
    ['未指定', '::'],
    ['ユニークローカル fc00::/7', 'fc00::1'],
    ['ユニークローカル fd00::', 'fd12:3456::1'],
    ['リンクローカル', 'fe80::1'],
    ['リンクローカル（範囲上端）', 'febf::1'],
    ['マルチキャスト', 'ff02::1'],
    ['ドキュメント用', '2001:db8::1'],
  ])('塞ぐ（%s）', (_label, address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    ['一般的な公開IPv6', '2606:2800:220:1:248:1893:25c8:1946'],
    ['fec0 はリンクローカルではない', 'fec0::1'],
    ['fb はユニークローカルではない', 'fbff::1'],
  ])('通す（%s）', (_label, address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  // IPv6 表記で同じ宛先へ到達できてしまうのを防ぐ
  it.each([
    ['ループバックのIPv4射影', '::ffff:127.0.0.1'],
    ['プライベートのIPv4射影', '::ffff:10.0.0.1'],
    ['メタデータのIPv4射影', '::ffff:169.254.169.254'],
  ])('IPv4射影も同じ判定にする（%s）', (_label, address) => {
    expect(isBlockedAddress(address)).toBe(true);
    expect(classifyAddress(address).reason).toContain('IPv4射影');
  });

  it('公開IPのIPv4射影は通す', () => {
    expect(isBlockedAddress('::ffff:93.184.216.34')).toBe(false);
  });

  it.each([
    ['NAT64 でループバック', '64:ff9b::127.0.0.1'],
    ['NAT64 でプライベート', '64:ff9b::10.0.0.1'],
  ])('NAT64 の埋め込みIPv4も判定する（%s）', (_label, address) => {
    expect(isBlockedAddress(address)).toBe(true);
    expect(classifyAddress(address).reason).toContain('NAT64');
  });

  it('NAT64 で公開IPなら通す', () => {
    expect(isBlockedAddress('64:ff9b::93.184.216.34')).toBe(false);
  });
});

describe('解釈できない値', () => {
  it.each([
    ['空文字', ''],
    ['ホスト名', 'example.com'],
    ['数値だけ', '2130706433'],
    ['ごみ', 'not-an-address'],
  ])('判定できないものは塞ぐ（%s）', (_label, value) => {
    expect(isBlockedAddress(value)).toBe(true);
  });

  it('前後の空白は無視する', () => {
    expect(isBlockedAddress('  93.184.216.34  ')).toBe(false);
    expect(isBlockedAddress('  127.0.0.1  ')).toBe(true);
  });
});
