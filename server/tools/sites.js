'use strict';

module.exports = {
  async test_connection(ctx) {
    const user = await ctx.request('/users/me?context=edit');
    const can = user.capabilities || {};
    return ctx.result({
      connected: true,
      user_id: user.id,
      name: user.name,
      slug: user.slug,
      roles: user.roles,
      permissions: {
        upload_files: !!can.upload_files,
        publish_posts: !!can.publish_posts,
        edit_posts: !!can.edit_posts,
        edit_others_posts: !!can.edit_others_posts,
      },
      rest_api_style: ctx.usesPlainPermalinks() ? 'plain (?rest_route=)' : 'pretty (/wp-json)',
      note: 'Capabilities reported by WordPress; write endpoints have not been exercised.',
    });
  },
};
