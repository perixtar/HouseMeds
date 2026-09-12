// Prepare the selected file locally. Original files are never modified.
export async function preparePhoto(file) {
  if (file.size > 10_000_000) throw Error('Choose a photo under 10 MB.');
  let blob = file;
  if (/\.(heic|heif)$/i.test(file.name) || ['image/heic', 'image/heif'].includes(file.type)) {
    const {heicTo} = await import('heic-to/csp');
    blob = await heicTo({blob: file, type: 'image/jpeg', quality: .93});
  }
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(blob.type)) throw Error('Choose a JPEG, PNG, WebP or HEIC photo.');
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, 3600 / Math.max(bitmap.width, bitmap.height));
  if (scale < 1 || blob.size > 3_750_000) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .88));
  }
  bitmap.close();
  if (!blob || blob.size > 3_750_000) throw Error('This photo is too large after preparation. Choose a smaller photo.');
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob);
  });
  return {image: {format: blob.type.split('/')[1], data: data.split(',')[1]}, preview: URL.createObjectURL(blob)};
}
