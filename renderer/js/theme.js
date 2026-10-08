// Applied in <head> so the saved theme is set before first paint (no flash).
document.documentElement.dataset.theme = (localStorage.getItem('devoping-theme') || localStorage.getItem('devowatch-theme')) === 'light' ? 'light' : 'dark';
