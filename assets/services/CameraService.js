export class CameraService {
  constructor() { this.stream = null; this.state = 'idle'; }

  async request(videoElement) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持摄像头访问');
    if (!this.stream) {
      this.state = 'requesting';
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
    }
    this.state = 'ready';
    if (videoElement) await this.attach(videoElement);
    return this.stream;
  }

  async attach(videoElement) {
    if (!this.stream || !videoElement) return;
    videoElement.srcObject = this.stream;
    videoElement.setAttribute('playsinline', '');
    await videoElement.play().catch(() => {});
  }

  snapshot(videoElement) {
    if (!videoElement?.videoWidth) return null;
    const canvas = document.createElement('canvas');
    canvas.width = videoElement.videoWidth;
    canvas.height = videoElement.videoHeight;
    canvas.getContext('2d').drawImage(videoElement, 0, 0);
    return canvas;
  }
}
