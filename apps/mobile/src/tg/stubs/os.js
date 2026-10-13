/** Stub os — hanya dipakai untuk default deviceModel/systemVersion (kita selalu isi eksplisit). */
module.exports = {
  type: () => 'Linux',
  release: () => '1.0',
  platform: () => 'android',
  arch: () => 'arm64',
  EOL: '\n',
  hostname: () => 'unknown',
};
