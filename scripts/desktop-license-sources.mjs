// The published crates/wheel below omit these texts. Pin the exact upstream
// revision and bytes; a new package version must be reviewed, not guessed.
const github = 'https://raw.githubusercontent.com';
const webview = (revision) => ['LICENSE', `${github}/wravery/webview2-rs/${revision}/LICENSE`,
  '0dcf41516e608bbcb6cdc5229feb7b86fe4a643b85e7df251133c93408fdac73'];
const spdx = `${github}/spdx/license-list-data/ab9b0904b43db6f4b67431efd8821feb821f1c8b/text`;
const objc = (revision, triple = false) => [
  ['LICENSE.md', `${github}/madsmtm/objc2/${revision}/LICENSE.md`, '7f976f7e9cb2d87df7230606feb932c3f21ac0e664045a775b600046ff850c54'],
  ['LICENSE-MIT', `${spdx}/MIT.txt`, 'b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5'],
  ...(triple ? [
    ['LICENSE-APACHE', `${spdx}/Apache-2.0.txt`, '074e6e32c86a4c0ef8b3ed25b721ca23aca83df277cd88106ef7177c354615ff'],
    ['LICENSE-ZLIB', `${spdx}/Zlib.txt`, 'bfb1112d49db5b1daecdfef24bd7e2f3ea0bafb33aa67aa0ab51e2bf8407c03d'],
  ] : []),
];
const objcFramework = objc('7b1abfd750a2cacaea71d6a56ecfb83cb7de560b', true);
const dlopen = ['LICENSE', `${github}/OpenByteDev/dlopen2/cc80e4a0a90d499b677fdf7743699b4b3a43a989/LICENSE`,
  '39fa265207450e77c62e90c5594a06c085b655d8374c7ced4bf7894b6bd95dd2'];
const notification = `${github}/h4llow3En/mac-notification-sys/deb559683962d314a7693478476bf8d052efa84e`;
const indicator = `${github}/tauri-apps/libappindicator-rs/eafd1e3682a1247f595410266091e9684021cb6f`;
export const crateLicenseSources = {
  'block2@0.6.2': objc('b4167b582b2f75f9a1be75495c41b765344fd03c'),
  'dispatch2@0.3.1': objc('8852b424193ca41602281b3d7540d7c8ed51e49a', true),
  'mac-notification-sys@0.6.15': [
    ['LICENSE-APACHE', `${notification}/LICENSE-Apache`, 'b40930bbcf80744c86c46a12bc9da056641d722716c378f5659b9e555ef833e1'],
    ['LICENSE-MIT', `${notification}/LICENSE-MIT`, '1299b4d9d15e9d67e4ac0e7d47ae9404887ca3cf0764aadeec7588d5a6e8e0cc'],
  ],
  'objc2@0.6.5': objc('d7d2fa23ceaa5e6096c923b081040e5d81b3b9df'),
  'objc2-app-kit@0.3.2': objcFramework,
  'objc2-core-foundation@0.3.2': objcFramework,
  'objc2-core-graphics@0.3.2': objcFramework,
  'objc2-encode@4.1.0': objc('8d214f5477365ffcbcbb7de058c86ed9a518efb7'),
  'objc2-foundation@0.3.2': objc('7b1abfd750a2cacaea71d6a56ecfb83cb7de560b'),
  'objc2-exception-helper@0.1.1': objc('8d214f5477365ffcbcbb7de058c86ed9a518efb7', true),
  'objc2-io-surface@0.3.2': objcFramework,
  'objc2-osa-kit@0.3.2': objcFramework,
  'objc2-quartz-core@0.3.2': objcFramework,
  'objc2-web-kit@0.3.2': objcFramework,
  'dlopen2@0.8.2': [dlopen],
  'dlopen2_derive@0.4.3': [dlopen],
  'libappindicator-sys@0.9.0': [
    ['LICENSE-APACHE', `${indicator}/LICENSE-APACHE`, 'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'],
    ['LICENSE-MIT', `${indicator}/LICENSE-MIT`, 'eb227437252b2a7a9c1fc342c93ade1f3d7ce38cc6dd754f613db07d53ceff0b'],
  ],
  'alloc-stdlib@0.3.0': [['LICENSE', `${github}/dropbox/rust-alloc-no-stdlib/0a81fd6928ea3b33c8cd484aa4575d50ffb98012/LICENSE`,
    'c0c56f26d9c051cac4d200c34c84e7ae9aaa853e01a982a1df08b09931e518ae']],
  'selectors@0.38.0': [['LICENSE-MPL-2.0', 'https://www.mozilla.org/media/MPL/2.0/index.815ca599c9df.txt',
    'fab3dd6bdab226f1c08630b1dd917e11fcb4ec5e1e020e2c16f83a0a13863e85']],
  'webview2-com@0.39.1': [webview('edc2caf886175ccaebe86078c9cfe1ae2a187328')],
  'webview2-com-macros@0.8.1': [webview('dffa41a8a46d3f5565eefbff2de57d38d399f158')],
  'webview2-com-sys@0.39.1': [webview('edc2caf886175ccaebe86078c9cfe1ae2a187328')],
};

const sqliteVec = `${github}/asg017/sqlite-vec/e9f598abfa0c06b328d8fe5da9c3760cce74be10`;
export const wheelLicenseSources = {
  'sqlite_vec-0.1.9.dist-info': [
    ['LICENSE-APACHE', `${sqliteVec}/LICENSE-APACHE`, 'a38070a94d4afd9cd710e3ce67bd1de78097cfe1784c1f0109ac95d3c196bfdc'],
    ['LICENSE-MIT', `${sqliteVec}/LICENSE-MIT`, '6ce72bbe12d975bd5286e5ab0a064c069693300c47bccbc57bec18485f1621ea'],
  ],
};
