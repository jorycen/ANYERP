const test = require('node:test');
const assert = require('node:assert/strict');
const salesRouter = require('../src/modules/sales/routes');
const salesController = require('../src/modules/sales/controller');

test('国补照片查询、替换和下载路由已注册并使用统一服务端权限角色', () => {
  const paths = salesRouter.stack.map(layer => `${layer.methods.join(',')}:${layer.path}`);
  assert.ok(paths.some(path => path.includes('GET:/subsidy-photos')));
  assert.ok(paths.some(path => path.includes('GET:/subsidy-photos/batch-download-ticket')));
  assert.ok(paths.some(path => path.includes('GET:/subsidy-photos/batch-download')));
  assert.ok(paths.some(path => path.includes('GET:/subsidy-photos/:orderId/download')));
  assert.ok(paths.some(path => path.includes('POST:/subsidy-photos/:orderId')));
  assert.ok(paths.some(path => path.includes('GET:/subsidy-photos/:orderId/files/:photoId')));
  assert.equal(typeof salesController.listSubsidyPhotos, 'function');
  assert.equal(typeof salesController.replaceSubsidyPhotos, 'function');
  assert.equal(typeof salesController.downloadSubsidyPhoto, 'function');
  assert.equal(typeof salesController.downloadSubsidyPhotosArchive, 'function');
  assert.equal(typeof salesController.downloadAllSubsidyPhotosArchive, 'function');
  assert.equal(typeof salesController.createSubsidyPhotosDownloadTicket, 'function');
});

test('国补照片查询结果批量下载必须指定筛选条件', () => {
  const { hasSubsidyPhotoFilter } = salesController._test;
  assert.equal(hasSubsidyPhotoFilter({}), false);
  assert.equal(hasSubsidyPhotoFilter({ subsidyPerson: '张三' }), true);
  assert.equal(hasSubsidyPhotoFilter({ startDate: '2026-08-01', endDate: '2026-08-04' }), true);
  assert.equal(hasSubsidyPhotoFilter({ storeId: 'STORE-1' }), true);
});

test('国补照片兼容历史字符串、对象和本地文件元数据', () => {
  const { normalizeSubsidyPhotos } = salesController._test;
  const photos = normalizeSubsidyPhotos([
    'https://example.com/legacy.jpg',
    { name: '云端照片', url: 'cloud://subsidy.jpg' },
    { name: '可推导公共地址', url: 'cloud://cloud1-8glwjlnq4c74f7f1.636c-cloud1-8glwjlnq4c74f7f1-1410946266/subsidy_photos/demo.jpg' },
    { name: '带公共地址的云端照片', url: 'cloud://subsidy-public.jpg', displayUrl: 'https://example.com/subsidy-public.jpg' },
    { id: 'LOCAL_1', name: '本地照片', storage: 'local', storage_name: 'LOCAL_1.png' }
  ]);
  assert.equal(photos.length, 5);
  assert.equal(photos[0].storage, 'external');
  assert.equal(photos[1].url, 'cloud://subsidy.jpg');
  assert.equal(photos[2].displayUrl, 'https://636c-cloud1-8glwjlnq4c74f7f1-1410946266.tcb.qcloud.la/subsidy_photos/demo.jpg');
  assert.equal(photos[3].displayUrl, 'https://example.com/subsidy-public.jpg');
  assert.equal(photos[4].storageName, 'LOCAL_1.png');
});

test('国补照片权限包含总部、财务和店长但不包含普通店员', () => {
  const { userCanViewSubsidyPhotos } = salesController._test;
  assert.equal(userCanViewSubsidyPhotos({ roles: ['boss'] }), true);
  assert.equal(userCanViewSubsidyPhotos({ roles: ['finance'] }), true);
  assert.equal(userCanViewSubsidyPhotos({ roles: ['manager'] }), true);
  assert.equal(userCanViewSubsidyPhotos({ roles: ['clerk'] }), false);
});

test('国补照片导出文件自动补齐扩展名并按 YYYYDDMM姓名手机号命名目录', () => {
  const { subsidyPhotoFileName, subsidyPhotoDownloadName, subsidyPhotoFolderName } = salesController._test;
  assert.equal(subsidyPhotoFileName({ name: '身份证', mimeType: 'image/png' }, 0), '身份证.png');
  assert.equal(subsidyPhotoFileName({ name: '照片', storageName: 'file-1.webp' }, 1), '照片.webp');
  assert.equal(subsidyPhotoFileName({ name: '照片.jpg', mimeType: 'image/png' }, 2), '照片.jpg');
  assert.equal(subsidyPhotoFolderName({ create_time: '2026-08-11T03:04:05.000Z', subsidy_person: '张三', customer_phone: '13800138000' }), '20261108张三13800138000');
  assert.equal(subsidyPhotoDownloadName({ order_no: 'SO-001', subsidy_person: '张三' }, { name: 'SN.jpg' }, 0), 'SO-001_张三_SN.jpg');
  assert.equal(subsidyPhotoDownloadName({ order_no: 'SO-001', subsidy_person: '张三' }, { name: 'SO-001_张三_SN.jpg' }, 0), 'SO-001_张三_SN.jpg');
  assert.equal(subsidyPhotoDownloadName({ order_no: 'SO/001', subsidy_person: '张/三' }, { name: '身份证', mimeType: 'image/png' }, 1), 'SO_001_张_三_身份证.png');
});
