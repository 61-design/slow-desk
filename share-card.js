(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  let selection, cardFile, cardUrl, generation = 0;
  function release() {
    if (cardUrl) URL.revokeObjectURL(cardUrl);
    cardUrl = null; cardFile = null;
  }
  const loadImage = src => new Promise((resolve, reject) => {
    const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = src;
  });
  async function makeCard(track, collection, url) {
    const image = await loadImage('assets/desk.png');
    if (document.fonts) await document.fonts.ready;
    const canvas = document.createElement('canvas'); canvas.width = 900; canvas.height = 1200;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f1f2e9'; ctx.fillRect(0, 0, 900, 1200);
    const scale = Math.max(900 / image.width, 580 / image.height);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, 900, 580); ctx.clip();
    ctx.drawImage(image, (900 - image.width * scale) / 2, (580 - image.height * scale) / 2, image.width * scale, image.height * scale);
    ctx.restore();
    ctx.fillStyle = '#405b43'; ctx.font = '28px sans-serif'; ctx.fillText('慢慢书桌', 64, 650);
    ctx.fillStyle = '#6f7868'; ctx.font = '22px sans-serif'; ctx.fillText(collection.title + ' · 分享一首喜欢的歌', 64, 699);
    ctx.fillStyle = '#304933';
    let fontSize = 57;
    do { ctx.font = `${fontSize--}px "Songti SC", "Noto Serif CJK SC", serif`; } while (ctx.measureText(track.title).width > 770 && fontSize > 20);
    ctx.fillText(track.title, 64, 792);
    ctx.font = '25px "Songti SC", serif'; ctx.fillStyle = '#63725b';
    ctx.fillText('音乐慢慢放，事情慢慢做。', 64, 859);
    ctx.fillStyle = '#cbd3c2'; ctx.fillRect(64, 918, 772, 1);
    const qr = window.qrcode(0, 'M'); qr.addData(url); qr.make();
    const count = qr.getModuleCount(), cell = 4, margin = 4;
    const size = (count + margin * 2) * cell, left = 64, top = 955;
    ctx.fillStyle = '#fff'; ctx.fillRect(left, top, size, size);
    ctx.fillStyle = '#233e29';
    for (let row = 0; row < count; row++) for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) ctx.fillRect(left + (col + margin) * cell, top + (row + margin) * cell, cell, cell);
    }
    const textLeft = left + size + 30;
    ctx.font = '25px sans-serif'; ctx.fillText('扫码，听这首歌', textLeft, 1028);
    ctx.font = '21px sans-serif'; ctx.fillStyle = '#71816b'; ctx.fillText('工作 · 学习 · 放松', textLeft, 1071);
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('image')), 'image/png'));
  }
  async function open(track, collection) {
    const token = ++generation; release();
    const url = new URL('https://61-design.github.io/slow-desk/');
    url.searchParams.set('track', track.id); url.searchParams.set('from', 'share');
    selection = {track, url:url.href};
    $('share-status').textContent = '正在准备分享卡片…';
    ['share-card-image', 'save-share-card', 'send-share-card', 'share-url'].forEach(id => $(id).hidden = true);
    $('share-dialog').showModal();
    try {
      const blob = await makeCard(track, collection, url.href);
      if (token !== generation || !$('share-dialog').open) return;
      cardFile = new File([blob], `慢慢书桌-${track.title.replace(/[\\/:*?"<>|]/g, '')}.png`, {type:'image/png'});
      cardUrl = URL.createObjectURL(blob);
      $('share-card-image').src = cardUrl; $('share-card-image').alt = `慢慢书桌分享卡片：${collection.title} · ${track.title}，扫码打开歌曲`;
      $('share-card-image').hidden = false;
      $('save-share-card').href = cardUrl; $('save-share-card').download = cardFile.name; $('save-share-card').hidden = false;
      $('send-share-card').hidden = !(navigator.canShare && navigator.canShare({files:[cardFile]}));
      $('share-status').textContent = '保存卡片发给朋友，扫码就能找到这首歌。也可以长按图片保存。';
    } catch {
      if (token === generation) $('share-status').textContent = '卡片暂时没生成成功，仍然可以复制歌曲链接。';
    }
  }
  $('close-share').addEventListener('click', () => $('share-dialog').close());
  $('share-dialog').addEventListener('close', () => { generation++; release(); });
  $('copy-share-link').addEventListener('click', async () => {
    if (!selection) return;
    try {
      await navigator.clipboard.writeText(selection.url);
      $('share-status').textContent = '歌曲链接已复制，可以发给朋友了。';
    } catch {
      $('share-url').value = selection.url; $('share-url').hidden = false;
      $('share-url').focus(); $('share-url').select();
      $('share-status').textContent = '长按或复制下方链接，发给朋友。';
    }
  });
  $('send-share-card').addEventListener('click', async () => {
    if (!cardFile) return;
    try { await navigator.share({files:[cardFile], title:`慢慢书桌 · ${selection.track.title}`, text:selection.url}); }
    catch (error) { if (error.name !== 'AbortError') $('share-status').textContent = '可以先保存卡片，再发给朋友。'; }
  });
  window.SlowDeskShare = {open};
})();
