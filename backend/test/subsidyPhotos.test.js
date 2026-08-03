const test = require('node:test');
const assert = require('node:assert/strict');
const salesRouter = require('../src/modules/sales/routes');
const salesController = require('../src/modules/sales/controller');

test('国补照片查询、替换和下载路由已注册并使用统一服务端权限角色', () => {
  const paths = salesRouter.stack.map(layer => `${layer.methods.join(',')}:${layer.path}`);
  assert.ok(paths.some(path => path.includes('GET:/subsidy-photos')));
  assert.ok(paths.some(path => path.includes('GET:/subsidy-photos/:orderId/download')));
  assert.ok(paths.some(path => path.includes('POST:/subsidy-photos/:orderId')));
  assert.ok(paths.some(path => path.includes('GET:/subsidy-photos/:orderId/files/:photoId')));
  assert.equal(typeof salesController.listSubsidyPhotos, 'function');
  assert.equal(typeof salesController.replaceSubsidyPhotos, 'function');
  assert.equal(typeof salesController.downloadSubsidyPhoto, 'function');
  assert.equal(typeof salesController.downloadSubsidyPhotosArchive, 'function');
});

test('国补照片兼容历史字符串、对象和本地文件元数据', () => {
  const { normalizeSubsidyPhotos } = salesController._test;
  const photos = normalizeSubsidyPhotos([
    'https://example.com/legacy.jpg',
    { name: '云端照片', url: 'cloud://subsidy.jpg' },
    { id: 'LOCAL_1', name: '本地照片', storage: 'local', storage_name: 'LOCAL_1.png' }
  ]);
  assert.equal(photos.length, 3);
  assert.equal(photos[0].storage, 'external');
  assert.equal(photos[1].url, 'cloud://subsidy.jpg');
  assert.equal(photos[2].storageName, 'LOCAL_1.png');
});

test('国补照片权限包含总部、财务和店长但不包含普通店员', () => {
  const { userCanViewSubsidyPhotos } = salesController._test;
  assert.equal(userCanViewSubsidyPhotos({ roles: ['boss'] }), true);
  assert.equal(userCanViewSubsidyPhotos({ roles: ['finance'] }), true);
  assert.equal(userCanViewSubsidyPhotos({ roles: ['manager'] }), true);
  assert.equal(userCanViewSubsidyPhotos({ roles: ['clerk'] }), false);
});
