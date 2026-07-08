const Router = require('koa-router');
const multer = require('@koa/multer');
const { recognizeCoupon } = require('./controller');

const router = new Router();
const upload = multer({
  limits: {
    files: 1,
    fileSize: Number(process.env.OCR_MAX_IMAGE_SIZE_MB || 8) * 1024 * 1024
  }
});

router.post('/coupon', upload.single('image'), recognizeCoupon);

module.exports = router;
