/* ── Landing Page JS — Cronos ──────────────────────────────────────────────── */

(function () {
  'use strict';

  // ── Navbar scroll effect ────────────────────────────────────────────────
  const navbar = document.getElementById('navbar');
  window.addEventListener('scroll', function () {
    navbar.classList.toggle('scrolled', window.scrollY > 50);
  });

  // ── Mobile hamburger menu ───────────────────────────────────────────────
  const hamburger = document.getElementById('hamburger');
  const navLinks = document.getElementById('navLinks');

  hamburger.addEventListener('click', function () {
    navLinks.classList.toggle('open');
  });

  // Close menu when clicking a nav link
  navLinks.querySelectorAll('a').forEach(function (link) {
    link.addEventListener('click', function () {
      navLinks.classList.remove('open');
    });
  });

  // ── Smooth scroll for anchor links ──────────────────────────────────────
  document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
    anchor.addEventListener('click', function (e) {
      var target = document.querySelector(this.getAttribute('href'));
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  // ── FAQ Accordion ───────────────────────────────────────────────────────
  document.querySelectorAll('.faq-question').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var item = this.closest('.faq-item');
      var isActive = item.classList.contains('active');

      // Close all other items
      document.querySelectorAll('.faq-item.active').forEach(function (openItem) {
        openItem.classList.remove('active');
      });

      // Toggle current item
      if (!isActive) {
        item.classList.add('active');
      }
    });
  });

})();
