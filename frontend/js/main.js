/**
 * main.js — Home page animation logic only.
 * Kept deliberately tiny: no framework, no build step, just the DOM APIs.
 */
(function () {
  "use strict";

  // 1) Play the Nova mark's one-time "flare" the moment the page paints.
  //    Runs on every .nova-mark on the page (nav + footer).
  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll(".nova-mark").forEach((mark, i) => {
      // Stagger slightly so nav and footer marks don't flare in perfect unison.
      setTimeout(() => mark.classList.add("is-flaring"), 120 + i * 80);
    });
  });

  // 2) Reveal-on-scroll: elements marked [data-reveal] fade/slide in once
  //    they enter the viewport. Hero items reveal immediately on load;
  //    anything further down reveals as the user scrolls to it.
  const revealTargets = document.querySelectorAll("[data-reveal]");

  if (!("IntersectionObserver" in window) || revealTargets.length === 0) {
    // Graceful fallback: just show everything.
    revealTargets.forEach((el) => el.classList.add("is-visible"));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry, index) => {
        if (entry.isIntersecting) {
          // Small stagger for elements that reveal together (e.g. hero block).
          setTimeout(() => entry.target.classList.add("is-visible"), index * 90);
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.15, rootMargin: "0px 0px -40px 0px" }
  );

  revealTargets.forEach((el) => observer.observe(el));
})();
