// Keep the household picker one tap away while editing a person's medicines.
(() => {
  const back = document.querySelector('#backButton');
  const screens = document.querySelectorAll('.screen');
  if (!back) return;

  const updateBackButton = () => {
    const current = document.querySelector('.screen.active')?.id;
    back.style.visibility = current === 'house' ? 'hidden' : 'visible';
  };

  back.addEventListener('click', () => {
    const current = document.querySelector('.screen.active')?.id;
    const destination = current === 'meds' ? 'choose' : current === 'detail' ? 'deals' : 'house';
    screens.forEach(screen => screen.classList.toggle('active', screen.id === destination));
    // The picker includes each member's medicine count, so refresh it before showing it.
    if (destination === 'choose' && typeof renderChoices === 'function') renderChoices();
    updateBackButton();
    window.scrollTo(0, 0);
  });

  new MutationObserver(updateBackButton).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
  updateBackButton();
})();
