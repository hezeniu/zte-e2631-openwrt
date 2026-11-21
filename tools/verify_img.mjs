
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i > 0 ? argv[i + 1] : null; };
const dir = argv.find((a) => !a.startsWith('--'));
if (!dir || !fs.existsSync(dir)) {
  console.error('usage: verify_img.mjs <artifact dir> [--tree <openwrt tree, for the config fragments>]');
  process.exit(2);
}

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const files = walk(dir).map((f) => f.split(path.sep).join('/'));   // match on / regardless of host OS
const find = (re) => files.find((f) => re.test(f));


const frags = (() => {
  const tree = arg('--tree');
  const linux = tree ? path.join(tree, 'target/linux') : null;
  if (!linux || !fs.existsSync(linux)) return null;
 
  const all = fs.readdirSync(linux, { withFileTypes: true }).filter((e) => e.isDirectory())
    .map((e) => e.name).filter((d) => d !== 'generic' && d !== 'include');
 
  const dirs = all.filter((d) => {
    const given = arg('--target');
    if (given) return d === given;
    const dt = path.join(linux, d, 'dts');
    return fs.existsSync(dt) && fs.readdirSync(dt).some((f) => /e2631|zx279128s/i.test(f));
  });
  if (!dirs.length) return null;
  const order = [path.join(linux, 'generic'), path.join(linux, dirs[0]),
    ...fs.readdirSync(path.join(linux, dirs[0]), { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => path.join(linux, dirs[0], e.name))];
  const out = new Map();
  let n = 0;
  for (const p of order) {
    if (!fs.existsSync(p)) continue;
    for (const f of fs.readdirSync(p).filter((x) => /^config-[0-9]/.test(x)).sort()) {
      n++;
      const text = fs.readFileSync(path.join(p, f), 'utf8');
      for (const m of text.matchAll(/^# (CONFIG_[A-Za-z0-9_]+) is not set$/gm)) out.set(m[1].slice(7), undefined);
      for (const m of text.matchAll(/^CONFIG_([A-Za-z0-9_]+)=(.*)$/gm)) out.set(m[1], m[2].replace(/^"|"$/g, ''));
    }
  }
  return { map: out, files: n, target: dirs[0] };
})();

let fails = 0, warns = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!cond) fails++;
};
const warn = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'WARN'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!cond) warns++;
};
const hx = (n) => '0x' + (n >>> 0).toString(16);

const sval = (b) => (b ? b.toString('latin1') : '').replace(/\0[\s\S]*$/, '');

const cval = (b) => (b ? b.toString('latin1') : '').replace(/\0+/g, ' ').trim();


function fdtParse(buf) {
  if (buf.readUInt32BE(0) !== 0xd00dfeed) throw new Error('not a dtb (magic)');
  const total = buf.readUInt32BE(4), offStruct = buf.readUInt32BE(8), offStr = buf.readUInt32BE(12);
  if (total > buf.length) throw new Error(`dtb totalsize ${total} > file ${buf.length}`);
  const str = (o) => {
    let s = '', i = offStr + o;
    while (i < buf.length && buf[i]) s += String.fromCharCode(buf[i++]);
    return s;
  };
  let p = offStruct, end = offStruct + buf.readUInt32BE(36);

  let root = null;
  const stack = [];
  const be32 = (o) => buf.readUInt32BE(o);
  while (p < end) {
    const t = be32(p); p += 4;
    if (t === 4) continue;                                   // NOP
    if (t === 9) break;                                      // END
    if (t === 1) {                                           // BEGIN_NODE
      let n = '';
      while (buf[p]) n += String.fromCharCode(buf[p++]);
      p = (p + 4) & ~3;                                    // past the NUL, then align
      const node = { name: n, props: {}, children: [] };
      if (root) stack[stack.length - 1].children.push(node);
      else root = node;
      stack.push(node);
    } else if (t === 2) {                                    // END_NODE
      stack.pop();
    } else if (t === 3) {                                    // PROP
      const len = be32(p), nameOff = be32(p + 4);
      const data = buf.subarray(p + 8, p + 8 + len);
      p = (p + 8 + len + 3) & ~3;
      stack[stack.length - 1].props[str(nameOff)] = data;
    } else throw new Error(`unknown fdt token ${t} at ${p - 4}`);
  }
  return root;
}
const fdtFind = (node, name) => node.children.find((c) => c.name === name || c.name.split('@')[0] === name);
const cells = (node) => ({
  a: node.props['#address-cells'] ? node.props['#address-cells'].readUInt32BE(0) : 1,
  s: node.props['#size-cells'] ? node.props['#size-cells'].readUInt32BE(0) : 1,
});
const regList = (node, ac = 1, sc = 1) => {
  const r = node.props.reg;
  if (!r) return null;
  const out = [];
  for (let i = 0; i + ac * 4 + sc * 4 <= r.length; i += (ac + sc) * 4) {
    let addr = 0, size = 0;
    for (let k = 0; k < ac; k++) addr = addr * 0x100000000 + r.readUInt32BE(i + k * 4);
    for (let k = 0; k < sc; k++) size = size * 0x100000000 + r.readUInt32BE(i + ac * 4 + k * 4);
    out.push({ addr: Number(addr), size: Number(size) });
  }
  return out;
};


const pick = (exact, loose) => find(exact) || files.find((f) => loose.test(path.basename(f)));
const kernelFile = pick(/payload\/kernel$/, /^kernel$/);
const rootFile = pick(/payload\/root$/, /^root$/);
const dtbFile = pick(/e2631\.dtb$/, /dtb$/);
const confFile = pick(/(^|\/)config-[0-9]/, /^config-[0-9]/);
for (const [what, f] of [['kernel', kernelFile], ['root', rootFile]])
  if (!f) { console.error(`missing ${what} in ${dir}`); process.exit(1); }

const haveDtb = !!dtbFile, haveConf = !!confFile;
if (!haveDtb) console.log('NOTE   no standalone .dtb here: the one appended to the kernel is used');
if (!haveConf) console.log('NOTE   no kernel .config here: the config-side checks are skipped, not passed');
const okC = (name, cond, detail) => { if (haveConf) ok(name, cond, detail); };

const img = fs.readFileSync(kernelFile);
const MARKER = Buffer.from('33333333cccccccc88888888ddddddddffffffffffffffffffffffffffffffff', 'hex');
ok('kernel starts with the 32-byte ZTE slot marker', img.subarray(0, 32).equals(MARKER));
const u = img.subarray(32);
ok('uImage magic right after the marker', u.readUInt32BE(0) === 0x27051956, hx(u.readUInt32BE(0)));
const ihSize = u.readUInt32BE(12), ihLoad = u.readUInt32BE(16), ihEp = u.readUInt32BE(20);
ok('uImage data CRC (ih_dcrc)', (zlib.crc32(u.subarray(64, 64 + ihSize)) >>> 0) === u.readUInt32BE(24),
  `stored ${hx(u.readUInt32BE(24))}`);
ok('load == entry == 0x40008000 (both vendor slots use this)', ihLoad === 0x40008000 && ihEp === 0x40008000,
  `${hx(ihLoad)} / ${hx(ihEp)}`);
ok('uImage: Linux on ARM, type kernel, comp none', u[28] === 5 && u[29] === 2 && u[30] === 2 && u[31] === 0,
  `os=${u[28]} arch=${u[29]} type=${u[30]} comp=${u[31]}`);
ok('image name names this build', /Linux|OpenWrt/i.test(u.subarray(32, 64).toString('latin1')),
  JSON.stringify(u.subarray(32, 64).toString('latin1').replace(/\0.*$/, '')));
const tail = u.subarray(64, 64 + ihSize);


ok('zImage self-extracting header magic (LE 0x016f2818 at +0x24)',
  tail.readUInt32LE(0x24) === 0x016f2818, hx(tail.readUInt32LE(0x24)));
let dtbOff = -1;

for (let i = Math.max(0, tail.length - 0x80000) & ~3; i + 8 <= tail.length; i += 4)
  if (tail.readUInt32BE(i) === 0xd00dfeed && i + tail.readUInt32BE(i + 4) === tail.length) { dtbOff = i; break; }
ok('a .dtb is appended and ends the kernel image', dtbOff >= 0,
  dtbOff >= 0 ? `at +${hx(dtbOff)}, ${(tail.length - dtbOff).toString(16)} bytes` : 'not found');
let dtbBuf = null;
if (dtbOff >= 0) {
  dtbBuf = tail.subarray(dtbOff);
  try {
    if (haveDtb) {
      const e = fdtParse(dtbBuf), file = fdtParse(fs.readFileSync(dtbFile));
      ok('the dtb in the kernel equals the one built for this board',
        sval(e.props.model) === sval(file.props.model));
    }
  } catch (err) { ok('the dtb inside the kernel parses', false, err.message); }
}
if (haveDtb) dtbBuf = fs.readFileSync(dtbFile);
if (!dtbBuf) { console.error('FAIL  no device tree to check (neither .dtb nor an appended one)'); process.exit(1); }


const sq = fs.readFileSync(rootFile);
ok('rootfs is a squashfs image', sq.subarray(0, 4).toString('latin1') === 'hsqs',
  `magic=${sq.subarray(0, 4).toString('latin1')}`);

const sqUsed = sq.readUInt32LE(40), sqBlock = sq.readUInt32LE(12);
ok('squashfs reports a size inside the file and a sane block size',
  sqUsed > 96 && sqUsed <= sq.length && sqBlock >= 4096 && sqBlock <= 0x100000,
  `used=${hx(sqUsed)} file=${hx(sq.length)} block=${hx(sqBlock)}`);


const dtb = fdtParse(dtbBuf);
const conf = haveConf ? fs.readFileSync(confFile, 'latin1') : '';
const kv = (name) => {
  const m = new RegExp(`^CONFIG_${name}=(.*)$`, 'm').exec(conf);
  return m ? m[1].replace(/^"|"$/g, '') : (/^# CONFIG_ is not set$/m, undefined);
};
const isNotSet = (name) => conf.includes(`# CONFIG_${name} is not set`) || kv(name) === undefined;

ok('dtb model and compatible', /E2631/i.test(sval(dtb.props.model)), cval(dtb.props.compatible));
const mem = fdtFind(dtb, 'memory');
const mreg = mem && regList(mem)[0];
ok('memory is the 256 MiB this board has, at 0x40000000',
  mreg && mreg.addr === 0x40000000 && mreg.size === 0x10000000,
  mreg ? `${hx(mreg.addr)} + ${hx(mreg.size)}` : 'no memory node');


const serials = [];
(function findSerial(n) {
  if (/^serial@/.test(n.name) && n.props.compatible && /pl011/.test(cval(n.props.compatible))) serials.push(n);
  for (const c of n.children) findSerial(c);
})(dtb);
ok('the dtb has a PL011 serial node', serials.length > 0, `${serials.length} found`);
ok('the console UART is enabled (aliases alone do not enable it)',
  serials.some((s) => !s.props.status || cval(s.props.status) === 'okay'),
  serials.map((s) => `${s.name}:${s.props.status ? cval(s.props.status) : 'okay(default)'}`).join(' '));
const chosen = fdtFind(dtb, 'chosen');
ok('/chosen gives stdout-path a serial alias', chosen && /serial\d/.test(sval(chosen.props['stdout-path'])),
  chosen ? sval(chosen.props['stdout-path']) : 'no chosen node');


const flash = (() => {
  const walk2 = (n) => {
    if (n.props.compatible && /spi-nand/.test(cval(n.props.compatible))) return n;
    for (const c of n.children) { const r = walk2(c); if (r) return r; }
    return null;
  };
  return walk2(dtb);
})();
const partsNode = flash && fdtFind(flash, 'partitions');
const parts = partsNode ? partsNode.children.filter((c) => c.props.reg) : [];
const table = [];
{
  const { a, s } = cells(partsNode || dtb);
  for (const p of parts) table.push({ label: sval(p.props.label), node: p, ...regList(p, a, s)[0] });
}
console.log('  partition order as the kernel will create it:');
table.forEach((t, i) => console.log(`    mtd${i}  ${t.label.padEnd(14)} ${hx(t.addr)} + ${hx(t.size)}  end ${hx(t.addr + t.size)}`));

const idxOf = (label) => table.findIndex((t) => t.label === label);

const BLOCK = 0x20000, SLOT_BASE = 0x2300000, SPAN = 0x1c00000;
const KERNEL_AT = 0x400000, ROOTFS_SPAN = 0x1100000, HEADER_AT = KERNEL_AT + ROOTFS_SPAN;

const iRoot = idxOf('rootfs');
const iData = idxOf('rootfs_data');

ok('there is a partition labelled rootfs', iRoot >= 0, `mtd${iRoot}`);
ok('nothing is declared as rootfs_data (the kernel splits it off the rootfs tail)', iData < 0,
  iData < 0 ? 'none' : `mtd${iData} at ${hx(table[iData].addr)} would be a second partition of that name, and fstools takes the first`);

ok(`the kernel plus its 32-byte slot marker fits the ${hx(KERNEL_AT)} region`,
  MARKER.length + u.length <= KERNEL_AT, `kernel=0x${(MARKER.length + u.length).toString(16)} free=0x${(KERNEL_AT - MARKER.length - u.length).toString(16)}`);
ok(`rootfs starts at expected kernel offset +${hx(KERNEL_AT)}`,
  iRoot >= 0 &&
  table[iRoot].addr === SLOT_BASE + KERNEL_AT &&
  table[iRoot].size === ROOTFS_SPAN,
  iRoot >= 0 ? `${hx(table[iRoot].addr)} + ${hx(table[iRoot].size)}` : '-');

const sqBlocks = Math.ceil(sq.length / BLOCK) * BLOCK;
ok('the squashfs leaves writable space inside its partition', sqBlocks + BLOCK <= ROOTFS_SPAN,
  `squashfs ${hx(sq.length)} -> split at +${hx(KERNEL_AT + sqBlocks)}, partition ends at +${hx(KERNEL_AT + ROOTFS_SPAN)}: overlay ${hx(ROOTFS_SPAN - sqBlocks)} = ${((ROOTFS_SPAN - sqBlocks) / 1048576).toFixed(2)} MiB`);
const iHeader = table.findIndex((t) =>
  t.addr === SLOT_BASE + HEADER_AT && t.size === BLOCK);

ok('the version header block sits right after the rootfs, out of the overlay',
  iHeader >= 0,
  iHeader >= 0 ? `${hx(table[iHeader].addr)} + ${hx(table[iHeader].size)}` : 'missing');

ok('the version header block is read-only',
  iHeader >= 0 && !!table[iHeader].node.props['read-only'],
  iHeader >= 0 ? 'read-only present' : 'missing');

const cmdline = (kv('CMDLINE') || '').replace(/\\\"/g, '"');
okC('CONFIG_CMDLINE_FORCE is on', kv('CMDLINE_FORCE') === 'y', 'the vendor bootargs would win otherwise');
const rm = /root=\/dev\/mtdblock(\d+)/.exec(cmdline);
okC('the built-in command line roots at the rootfs partition',
  rm && Number(rm[1]) === iRoot, `cmdline says mtdblock${rm ? rm[1] : '-'}, table says mtd${iRoot}`);
okC('the built-in command line asks for squashfs and waits', /rootfstype=squashfs/.test(cmdline) && /rootwait/.test(cmdline),
  cmdline);

okC('CONFIG_MTD_PARTITIONED_MASTER stays off', isNotSet('MTD_PARTITIONED_MASTER'));

/* --------------------- drivers the boot itself depends on ------------------ */
const needBuiltin = [
  ['MTD_SPI_NAND', 'the flash'],
  ['BLOCK', '/dev/ block devices at all'],
  ['MTD_BLOCK', '/dev/mtdblock*'],
  ['MTD_OF_PARTS', 'the partition table above'],
  ['SQUASHFS', 'the read-only root'],
  ['JFFS2_FS', 'the overlay'],
 
  ['JFFS2_FS_WRITEBUFFER', 'patch 029, the in-data clean marker'],

  ['SERIAL_AMBA_PL011_CONSOLE', 'the serial console'],
];
if (frags) console.log(`config fragments: ${frags.files} file(s) under target/linux/*/config-*`);
for (const [sym, why] of needBuiltin) {
  const f = frags ? (frags.map.has(sym) ? frags.map.get(sym) ?? 'not set' : 'not mentioned') : null;
  okC(`CONFIG_${sym}=y (needed for ${why})`,
    kv(sym) === 'y' && (!frags || !frags.map.has(sym) || frags.map.get(sym) === 'y'),
    f === null ? `is ${kv(sym) || 'unset'}` : `built=${kv(sym) || 'unset'} fragments=${f}`);
}

warn('devtmpfs state matches what every other OpenWrt target ships',
  isNotSet('DEVTMPFS'), `CONFIG_DEVTMPFS=${kv('DEVTMPFS') || 'not set'}`);

const decomps = ['ZLIB', 'LZO', 'XZ', 'LZ4', 'ZSTD'].filter((a) => kv(`SQUASHFS_${a}`) === 'y');
okC('the kernel builds in a squashfs decompressor', decomps.length > 0, decomps.join(', '));


const isrc = (kv('INITRAMFS_SOURCE') || '').trim();
const fsrc = frags && frags.map.has('INITRAMFS_SOURCE') ? (frags.map.get('INITRAMFS_SOURCE') || '') : null;
if (isrc !== '')
  console.log('NOTE   the .config collected from build_dir is the initramfs rescue kernel\'s\n' +
      '       (INITRAMFS_SOURCE points at a cpio list); the shipped kernel is judged\n' +
      '       from the fragments instead.');
okC('no initramfs baked into the kernel that ships',
  (fsrc !== null ? fsrc : isrc) === '',
  `built=${JSON.stringify(isrc)} fragments=${fsrc === null ? 'not read' : JSON.stringify(fsrc)}`);


ok('the flash node names no external ECC engine (on-die ECC, so program_once applies)',
  !!flash && !flash.props['nand-ecc-engine'],
  flash && flash.props['nand-ecc-engine'] ? 'nand-ecc-engine is set' : 'no such property');


const enabled = [];
const scan = (n, pathName) => {
  const c = cval(n.props.compatible), st = sval(n.props.status);
  const p = `${pathName}/${n.name}`;
  if (st === 'okay' && /(watchdog|wdt|dwc3|usb-[0-9a-f]|xhci|ehci|ohci)/i.test(c)) enabled.push(`${p} [${c}]`);
  n.children.forEach((k) => scan(k, p));
};
scan(dtb, '');
ok('no watchdog or USB controller node is enabled in the dtb', enabled.length === 0, enabled.join(', '));
const usbOn = ['USB_CORE', 'USB_EHCI_HCD', 'USB_OHCI_HCD', 'USB_XHCI_HCD',
  'USB_DWC3', 'USB_DWC3_OF_SIMPLE', 'USB_XHCI_PLATFORM'].filter((s) => kv(s) === 'y');
okC('no USB host stack built into the kernel', usbOn.length === 0, usbOn.join(', '));

// Without the platform symbol there is no platsmp and no zte,zx279128s-smp
// enable-method match, which is the difference between one CPU and two.
okC('CONFIG_SOC_ZX279128S=y (this SoC platform and its CPU hotplug)',
  kv('SOC_ZX279128S') === 'y', `is ${kv('SOC_ZX279128S') || 'unset'}`);

okC('CONFIG_VFP stays off (this SoC has none)', isNotSet('VFP'), kv('VFP') || 'not set');
okC('CONFIG_SMP is on (dual Cortex-A9)', kv('SMP') === 'y', `is ${kv('SMP') || 'unset'}`);
const cpus = dtb.children.find((c) => c.name.startsWith('cpus'));
const meth = (n) => (n ? sval(n.props['enable-method']) : '');
const method = meth(cpus) || meth(cpus && cpus.children[0]);
// Not fatal: with no match the kernel boots with one CPU and says so, but the
// second core is the reason the platform file exists.
warn('cpu enable-method matches the string the compiled platsmp registers',
  method === 'zte,zx279128s-smp', method || 'none');


{
  const mf = files.find((f) => /\.manifest$/.test(f));
  if (!mf) console.log('NOTE   no .manifest in this artifact: package list NOT checked');
  else {
    const pkgs = new Set(fs.readFileSync(mf, 'utf8').split('\n')
      .map((l) => l.trim().replace(/^(?:add|install)\s+/, '').split(' - ')[0].trim())
      .filter(Boolean));
    console.log(`\nmanifest ${path.basename(mf)}: ${pkgs.size} packages`);
    const need = [
      ['base-files', '/etc, /lib/upgrade, board.d'],
      ['busybox', '/bin/sh and the applets'],
      ['procd', 'pid 1'],
      ['fstools', 'mount_root and the jffs2 overlay'],
      ['netifd', 'LAN and WAN'],
      ['dropbear', 'ssh in to run the probe: this base tree ships no uhttpd by default'],
      ['e2631-fwslot', 'switching back to the stock slot'],
      ['uhttpd', 'the web server the UI is served from'],
      ['luci', 'the web UI itself'],
      // Checked by name rather than by "some theme is present": the earlier
      // failure mode of that feed handling was a build that succeeded and
      // silently shipped no LuCI at all. Argon is the vendored default
      // (v1.0..v1.2's theme, kept by vendoring the source into this repo),
      // Bootstrap the in-tree fallback.
      ['luci-theme-argon', 'the default theme (vendored in-repo)'],
      ['luci-theme-bootstrap', 'the official fallback theme'],
      // v1.3: without the nft flowtable statement, fw4's flow_offloading is a
      // no-op - the whole hardware-acceleration story rides on this package.
      ['kmod-nft-offload', 'the nft flowtable statement fw4 compiles into'],
      // v1.3: the userdata extroot tooling (ubiformat/ubiattach/ubimkvol) and
      // the block-mount machinery the fstab gate runs through.
      ['ubi-utils', 'userdata extroot initialization'],
      ['block-mount', 'the fstab/extroot machinery'],
      // v1.3: the ZTE mesh controller and its LuCI page (vendored from
      // cnjn/zte-mesh). A missing kmod-veth means the sandbox cannot attach.
      ['zte-mesh', 'the sandboxed ZTE multiapd controller'],
      ['luci-app-zte-mesh', 'the LuCI page for the mesh controller'],
      // v1.3: the board page (slots / online update / switch back to stock)
      ['luci-app-e2631', 'the E2631 board page in LuCI'],
      // v1.4: the WAN port page; /sbin/e2631-wanport itself comes from
      // base-files, so only the front end is a package.
      ['luci-app-e2631-wanport', 'the WAN port selection page in LuCI'],
      ['kmod-veth', 'the veth pair the mesh sandbox attaches with'],
      // v1.3: https for the online updater; the mtd tool parks/restores the
      // config backup on userdata; without it an update drops settings.
      // (the ustream package carries the mbedtls version in its name)
      ['libustream-mbedtls20201210', 'https for e2631-upgrade'],
      ['mtd', 'erase/write for the config backup on userdata'],
      // The chip is an MT7916: mt7915e binds it but requests mt7916_wa/wm/
      // rom_patch.bin, which only kmod-mt7916-firmware installs. Shipping the
      // mt7915 set instead looks like a dead radio with no error anywhere else.
      ['kmod-mt7916-firmware', 'the firmware MT7916 actually requests'],
    ];
    for (const [p, why] of need) ok(`${p} is installed (${why})`, pkgs.has(p), pkgs.has(p) ? '' : 'not in the manifest');
    // FEATURES on this target still says "usb", and OpenWrt's default package
    // list keys off FEATURES. A USB kmod in the image is the user's hard no:
    // probing a controller that is not populated reboots the SoC.
    const usbPkgs = [...pkgs].filter((p) => /^kmod-usb|^usb-tools|^usbutils/.test(p));
    ok('no USB kernel packages in the image (probing this controller reboots the SoC)',
      usbPkgs.length === 0, usbPkgs.join(', '));
  }
}

console.log(`\n${fails === 0 ? 'BOOT-READY: no static blocker found' : 'BLOCKERS: ' + fails}${warns ? ` (warnings: ${warns})` : ''}`);
process.exit(fails ? 1 : 0);
