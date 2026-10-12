// GiftList & WishList Maker - Interactive Functionality
document.addEventListener('DOMContentLoaded', () => {
  // 1. Mobile Menu Toggle
  const menuToggle = document.querySelector('.menu-toggle');
  const navLinks = document.querySelector('.nav-links');

  if (menuToggle && navLinks) {
    menuToggle.addEventListener('click', () => {
      navLinks.classList.toggle('active');
      const isExpanded = navLinks.classList.contains('active');
      menuToggle.setAttribute('aria-expanded', isExpanded);
    });

    navLinks.addEventListener('click', (e) => {
      if (e.target.closest('a')) {
        navLinks.classList.remove('active');
        menuToggle.setAttribute('aria-expanded', 'false');
      }
    });

    // Close menu when clicking outside
    document.addEventListener('click', (e) => {
      if (!navLinks.contains(e.target) && !menuToggle.contains(e.target)) {
        navLinks.classList.remove('active');
        menuToggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // 2. FAQ Accordion
  const faqQuestions = document.querySelectorAll('.faq-question');
  faqQuestions.forEach((question) => {
    question.addEventListener('click', () => {
      const item = question.parentElement;
      const isActive = item.classList.contains('active');

      // Close other open FAQ items for clean UX
      document.querySelectorAll('.faq-item').forEach((faq) => {
        faq.classList.remove('active');
        faq.querySelector('.faq-question').setAttribute('aria-expanded', 'false');
      });

      if (!isActive) {
        item.classList.add('active');
        question.setAttribute('aria-expanded', 'true');
      }
    });
  });

  // 3. Dynamic Copyright Year
  const yearSpans = document.querySelectorAll('.current-year');
  const currentYear = new Date().getFullYear();
  yearSpans.forEach((span) => {
    span.textContent = currentYear;
  });

  // 4. Search, filter, and save gift guides across the site
  const savedGuideStorageKey = 'giftlist-saved-guides';
  const saveButtons = [...document.querySelectorAll('[data-save-guide]')];
  const guideIds = new Set(saveButtons.map((button) => button.dataset.saveGuide));
  const savedGuideIds = new Set(
    (localStorage.getItem(savedGuideStorageKey) || '')
      .split(',')
      .filter((guideId) => guideIds.has(guideId))
  );
  const savedGuideSummary = document.querySelector('.saved-guide-summary');

  const updateSavedGuides = () => {
    saveButtons.forEach((button) => {
      const isSaved = savedGuideIds.has(button.dataset.saveGuide);
      const label = button.querySelector('span');
      button.setAttribute('aria-pressed', String(isSaved));
      button.firstChild.textContent = isSaved ? '♥ ' : '♡ ';
      if (label) {
        if (!button.dataset.unsavedLabel) {
          button.dataset.unsavedLabel = label.textContent;
        }
        label.textContent = isSaved ? 'Saved' : button.dataset.unsavedLabel;
      }
    });

    if (savedGuideSummary) {
      const count = savedGuideIds.size;
      savedGuideSummary.textContent = count
        ? `${count} saved ${count === 1 ? 'guide' : 'guides'} · Your picks stay on this device.`
        : 'Save a guide to keep it close for later.';
    }
    localStorage.setItem(savedGuideStorageKey, [...savedGuideIds].join(','));
  };

  saveButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const guideId = button.dataset.saveGuide;
      if (savedGuideIds.has(guideId)) {
        savedGuideIds.delete(guideId);
      } else {
        savedGuideIds.add(guideId);
      }
      updateSavedGuides();
    });
  });
  updateSavedGuides();

  const guideSearch = document.getElementById('guide-search');
  const guideCards = [...document.querySelectorAll('.guide-card[data-guide-category]')];
  const guideFilters = [...document.querySelectorAll('[data-guide-filter]')];
  const guideResultCount = document.getElementById('guide-result-count');
  const guideEmptyState = document.getElementById('guide-empty-state');
  let activeGuideFilter = 'all';

  const filterGuides = () => {
    const searchTerm = guideSearch ? guideSearch.value.trim().toLowerCase() : '';
    let visibleCount = 0;

    guideCards.forEach((card) => {
      const matchesCategory = activeGuideFilter === 'all'
        || card.dataset.guideCategory === activeGuideFilter;
      const matchesSearch = !searchTerm || card.textContent.toLowerCase().includes(searchTerm);
      const isVisible = matchesCategory && matchesSearch;
      card.hidden = !isVisible;
      if (isVisible) {
        visibleCount += 1;
      }
    });

    if (guideResultCount) {
      guideResultCount.textContent = `${visibleCount} ${visibleCount === 1 ? 'guide' : 'guides'} to explore`;
    }
    if (guideEmptyState) {
      guideEmptyState.hidden = visibleCount !== 0;
    }
  };

  guideFilters.forEach((filter) => {
    filter.addEventListener('click', () => {
      activeGuideFilter = filter.dataset.guideFilter;
      guideFilters.forEach((button) => {
        const isActive = button === filter;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-pressed', String(isActive));
      });
      filterGuides();
    });
  });

  if (guideSearch) {
    guideSearch.addEventListener('input', filterGuides);
  }
  if (guideCards.length) {
    filterGuides();
  }

  // 5. Contact Form Simulated Submit
  const contactForm = document.getElementById('contactForm');
  const formSuccess = document.getElementById('formSuccess');
  if (contactForm) {
    contactForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const submitBtn = contactForm.querySelector('button[type="submit"]');
      if (submitBtn) {
        submitBtn.textContent = 'Sending...';
        submitBtn.disabled = true;
      }
      setTimeout(() => {
        contactForm.reset();
        if (formSuccess) {
          formSuccess.style.display = 'block';
        }
        if (submitBtn) {
          submitBtn.textContent = 'Message Sent!';
        }
      }, 700);
    });
  }
});
