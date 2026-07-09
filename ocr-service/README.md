# PaddleOCR Coupon Service

This service is deployed separately from `anyerp-api`. It receives an uploaded voucher image, runs PaddleOCR, and returns the detected coupon code.

## Tencent CloudBase deploy

Create a new CloudBase Run service from this repository:

- Service name: `anyerp-ocr` or `paddleocr-coupon`
- Build directory: `ocr-service`
- Dockerfile: `ocr-service/Dockerfile`
- Port: `8080`
- Recommended resources: at least 2 CPU / 4 GB memory

Optional environment variables:

```text
OCR_SERVICE_TOKEN=your-shared-secret
OCR_MAX_IMAGE_SIZE_MB=8
OCR_WORKER_TIMEOUT=180
```

After this service is deployed, configure the API service `anyerp-api`:

```text
OCR_SERVICE_URL=https://your-ocr-service-domain/ocr/coupon
OCR_SERVICE_TOKEN=your-shared-secret
```

If `OCR_SERVICE_TOKEN` is not set on this OCR service, do not set it on `anyerp-api`.

## Endpoints

```text
GET  /health
POST /ocr/coupon
```

`POST /ocr/coupon` expects multipart form data:

```text
image=<file>
scene=education_subsidy
```

Response:

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "couponCode": "ABC123456",
    "candidates": ["ABC123456"],
    "rawText": "...",
    "texts": ["..."]
  }
}
```
