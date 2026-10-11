import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: 'src',
  outDirTemplate: '{{browser}}-mv{{manifestVersion}}{{modeSuffix}}',
  manifest: {
    // Fork only: pins the unpacked extension id (ioghagoipeacdknjpnjmbdmnnhjmpmfe). Without it the
    // id is a hash of the build directory, so a build in a new directory starts with empty storage.
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAoUlY3qn1YpSclXt/9IvS9airB+wdUxQoh3paQZlPP/UKGYZn/wv/npdtA2Qa0OBvJCJ3GG2o60qlQXjnpk0XxAbsRVBhQGy0ix5U7B/vnXThKgSFKNP2FUlguACt8chmZLA7lnlBv0K/+6BFSpC/F7WxVkcQUuaJwfa5UFfppKX+CGNZsuV+1Wu/Qc+lejM5/fZ3jirdDBmjyLDe4SGW9hPDigEwLQh926ZDknB4AZbbjrNJ+cKI0DA0enH/lyeKv1vmgwlhZ7Zsml3glfl41SCfG3U7DKklt9H9XaK7nPzl+5BKSCSXsiG2WQqXxA417EL4QwOKwPjOK4tJacwVuwIDAQAB',
    name: 'Anicite',
    description:
      'Local-only analytics of your browsing activity. Understand your habits without compromising your privacy.',
    manifest_version: 3,
    incognito: 'not_allowed',
    permissions: ['storage', 'unlimitedStorage'],
    host_permissions: ['http://*/*', 'https://*/*'],
    action: {
      default_title: 'Anicite',
      default_popup: 'popup/index.html',
      default_icon: {
        16: 'icons/icon-16.png',
        32: 'icons/icon-32.png',
        48: 'icons/icon-48.png',
        128: 'icons/icon-128.png',
      },
    },
    icons: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
  },
});
