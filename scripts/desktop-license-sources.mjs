// The published crates/wheel below omit these texts. Pin the exact upstream
// revision and bytes; a new package version must be reviewed, not guessed.
const github = 'https://raw.githubusercontent.com';
const webview = (revision) => ['LICENSE', `${github}/wravery/webview2-rs/${revision}/LICENSE`,
  '0dcf41516e608bbcb6cdc5229feb7b86fe4a643b85e7df251133c93408fdac73'];
export const crateLicenseSources = {
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
