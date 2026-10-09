chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'play-sound' || !message.sound) return;
  // `message.sound` is the sound catalog's filename including extension
  // (e.g. "chime.wav", "notification-ping.mp3") — see soundChoiceSelect.
  const audio = new Audio(chrome.runtime.getURL(`sounds/${message.sound}`));
  audio.play().catch(() => {});
});
