<?php
/**
 * Plugin Name:       MKT Publisher SEO Bridge for Yoast & Rank Math
 * Description:       Lets the MKT WP Publisher extension for Claude read and update the SEO title, meta description, focus keyword and canonical URL of posts and pages managed by Yoast SEO or Rank Math, through the WordPress REST API.
 * Version:           1.1.0
 * Author:            Jayant
 * Requires at least: 5.6
 * Requires PHP:      7.4
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       mkt-wp-publisher-seo-bridge
 * Update URI:        false
 *
 * Adds one REST field, "mkt_seo", to posts and pages (edit context only):
 *   { "plugin": "yoast" | "rank-math" | "none", "version": "1.1.0",
 *     "title": "", "description": "", "focus_keyword": "", "canonical": "" }
 * Writing it requires permission to edit that post. An empty string removes a value.
 *
 * Neither SEO plugin registers its post meta for the REST API, which is why this bridge exists.
 * For existing posts the values are saved just BEFORE WordPress saves the post, so Yoast's cached
 * "indexable" (which drives the page's <title> and meta tags) is rebuilt with the new values right away.
 * For new posts they are saved right after creation; publishing then refreshes Yoast's cache.
 *
 * "Update URI: false" stops WordPress from offering an unrelated wordpress.org plugin with the same
 * folder name as an "update" for this one.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'MKT_SEO_BRIDGE_VERSION', '1.1.0' );

/** Maximum lengths accepted, far above what search engines display, to keep stored values sane. */
function mkt_seo_bridge_limits() {
	return array(
		'title'         => 300,
		'description'   => 1000,
		'focus_keyword' => 200,
		'canonical'     => 2048,
	);
}

/**
 * Meta keys for the active SEO plugin, or null when neither is active. Yoast wins if both are.
 */
function mkt_seo_bridge_keys() {
	if ( defined( 'WPSEO_VERSION' ) ) {
		return array(
			'plugin'        => 'yoast',
			'name'          => 'Yoast SEO',
			'title'         => '_yoast_wpseo_title',
			'description'   => '_yoast_wpseo_metadesc',
			'focus_keyword' => '_yoast_wpseo_focuskw',
			'canonical'     => '_yoast_wpseo_canonical',
		);
	}
	if ( defined( 'RANK_MATH_VERSION' ) || class_exists( 'RankMath' ) ) {
		return array(
			'plugin'        => 'rank-math',
			'name'          => 'Rank Math',
			'title'         => 'rank_math_title',
			'description'   => 'rank_math_description',
			'focus_keyword' => 'rank_math_focus_keyword',
			'canonical'     => 'rank_math_canonical_url',
		);
	}
	return null;
}

/** The post types the bridge supports (the extension works with posts and pages). */
function mkt_seo_bridge_post_types() {
	return array( 'post', 'page' );
}

/**
 * Save the given SEO values for one post. Only keys present in $value are touched; an empty string deletes.
 *
 * @return true|WP_Error
 */
function mkt_seo_bridge_save( $post_id, $value ) {
	$keys = mkt_seo_bridge_keys();
	if ( ! is_array( $value ) || ! $keys ) {
		return true; // Nothing to write; the extension checks "plugin" before sending.
	}
	if ( ! current_user_can( 'edit_post', $post_id ) ) {
		return new WP_Error( 'rest_cannot_edit', __( 'Sorry, you are not allowed to edit the SEO fields of this post.', 'mkt-wp-publisher-seo-bridge' ), array( 'status' => rest_authorization_required_code() ) );
	}
	foreach ( mkt_seo_bridge_limits() as $field => $max ) {
		if ( ! array_key_exists( $field, $value ) ) {
			continue;
		}
		$raw  = (string) $value[ $field ];
		$text = 'canonical' === $field ? esc_url_raw( trim( $raw ), array( 'http', 'https' ) ) : sanitize_text_field( $raw );
		$text = mb_substr( $text, 0, $max );
		if ( '' === $text ) {
			delete_post_meta( $post_id, $keys[ $field ] );
		} else {
			update_post_meta( $post_id, $keys[ $field ], wp_slash( $text ) );
		}
	}
	return true;
}

/** IDs whose SEO values were already saved before the post itself was saved (see rest_pre_insert below). */
$GLOBALS['mkt_seo_bridge_saved_early'] = array();

add_action(
	'rest_api_init',
	function () {
		$keys = mkt_seo_bridge_keys();
		foreach ( mkt_seo_bridge_post_types() as $post_type ) {
			// Existing posts: save the SEO values before WordPress saves the post, so Yoast's indexable is rebuilt
			// from the new values when the post is saved. Runs after the REST permission check and schema validation.
			add_filter(
				"rest_pre_insert_{$post_type}",
				function ( $prepared_post, $request ) {
					$value = $request->get_param( 'mkt_seo' );
					if ( is_array( $value ) && ! empty( $prepared_post->ID ) ) {
						$saved = mkt_seo_bridge_save( (int) $prepared_post->ID, $value );
						if ( is_wp_error( $saved ) ) {
							return $saved; // Stops the update before anything is written.
						}
						$GLOBALS['mkt_seo_bridge_saved_early'][ (int) $prepared_post->ID ] = true;
					}
					return $prepared_post;
				},
				10,
				2
			);

			$text = function ( $field, $description ) {
				$limits = mkt_seo_bridge_limits();
				return array(
					'type'        => 'string',
					'maxLength'   => $limits[ $field ],
					'description' => $description,
				);
			};
			$canonical            = $text( 'canonical', 'Canonical URL (http or https). Empty string removes it.' );
			$canonical['pattern'] = '^(|https?://[^\\s]+)$';

			register_rest_field(
				$post_type,
				'mkt_seo',
				array(
					'get_callback'    => function ( $object ) use ( $keys ) {
						if ( ! current_user_can( 'edit_post', $object['id'] ) ) {
							return null;
						}
						$value = array(
							'plugin'  => $keys ? $keys['plugin'] : 'none',
							'version' => MKT_SEO_BRIDGE_VERSION,
						);
						foreach ( array_keys( mkt_seo_bridge_limits() ) as $field ) {
							$value[ $field ] = $keys ? (string) get_post_meta( $object['id'], $keys[ $field ], true ) : '';
						}
						return $value;
					},
					'update_callback' => function ( $value, $post ) {
						if ( ! empty( $GLOBALS['mkt_seo_bridge_saved_early'][ $post->ID ] ) ) {
							unset( $GLOBALS['mkt_seo_bridge_saved_early'][ $post->ID ] );
							return true; // Already saved before the post was saved.
						}
						return mkt_seo_bridge_save( $post->ID, $value ); // New posts: they have an ID only now.
					},
					'schema'          => array(
						'description'          => 'SEO title, meta description, focus keyword and canonical URL (MKT Publisher SEO Bridge ' . MKT_SEO_BRIDGE_VERSION . ').',
						'type'                 => 'object',
						'context'              => array( 'edit' ),
						'additionalProperties' => false,
						'properties'           => array(
							// The enums tell the extension, via one OPTIONS request, which SEO plugin is active and which bridge version runs.
							'plugin'        => array(
								'type'     => 'string',
								'enum'     => array( $keys ? $keys['plugin'] : 'none' ),
								'readonly' => true,
							),
							'version'       => array(
								'type'     => 'string',
								'enum'     => array( MKT_SEO_BRIDGE_VERSION ),
								'readonly' => true,
							),
							'title'         => $text( 'title', 'SEO title. Empty string removes it.' ),
							'description'   => $text( 'description', 'Meta description. Empty string removes it.' ),
							'focus_keyword' => $text( 'focus_keyword', 'Focus keyword. Empty string removes it.' ),
							'canonical'     => $canonical,
						),
					),
				)
			);
		}
	}
);

/* ---------- Admin: Tools > MKT SEO Bridge status page ---------- */

add_action(
	'admin_menu',
	function () {
		add_management_page(
			__( 'MKT Publisher SEO Bridge', 'mkt-wp-publisher-seo-bridge' ),
			__( 'MKT SEO Bridge', 'mkt-wp-publisher-seo-bridge' ),
			'manage_options',
			'mkt-seo-bridge',
			'mkt_seo_bridge_render_status_page'
		);
	}
);

add_filter(
	'plugin_action_links_' . plugin_basename( __FILE__ ),
	function ( $links ) {
		$url = admin_url( 'tools.php?page=mkt-seo-bridge' );
		array_unshift( $links, '<a href="' . esc_url( $url ) . '">' . esc_html__( 'Status', 'mkt-wp-publisher-seo-bridge' ) . '</a>' );
		return $links;
	}
);

function mkt_seo_bridge_render_status_page() {
	if ( ! current_user_can( 'manage_options' ) ) {
		return;
	}
	$keys     = mkt_seo_bridge_keys();
	$icon     = plugins_url( 'assets/icon-128x128.png', __FILE__ );
	$both    = defined( 'WPSEO_VERSION' ) && ( defined( 'RANK_MATH_VERSION' ) || class_exists( 'RankMath' ) );
	$app_pass = function_exists( 'wp_is_application_passwords_available' ) ? wp_is_application_passwords_available() : true;
	$rows     = array(
		array( __( 'Bridge version', 'mkt-wp-publisher-seo-bridge' ), MKT_SEO_BRIDGE_VERSION, true ),
		array( __( 'SEO plugin', 'mkt-wp-publisher-seo-bridge' ), $keys ? $keys['name'] . ( $both ? ' ' . __( '(Yoast SEO and Rank Math are both active; Yoast SEO is used)', 'mkt-wp-publisher-seo-bridge' ) : '' ) : __( 'None found. Activate Yoast SEO or Rank Math.', 'mkt-wp-publisher-seo-bridge' ), (bool) $keys ),
		array( __( 'REST field', 'mkt-wp-publisher-seo-bridge' ), 'mkt_seo ' . __( 'on posts and pages', 'mkt-wp-publisher-seo-bridge' ), true ),
		array( __( 'Application Passwords', 'mkt-wp-publisher-seo-bridge' ), $app_pass ? __( 'Available', 'mkt-wp-publisher-seo-bridge' ) : __( 'Disabled on this site (a security plugin or setting may block them). The extension cannot log in until they are allowed.', 'mkt-wp-publisher-seo-bridge' ), $app_pass ),
	);
	?>
	<div class="wrap">
		<h1 style="display:flex;align-items:center;gap:12px;">
			<img src="<?php echo esc_url( $icon ); ?>" width="48" height="48" alt="" style="border-radius:10px;" />
			<?php esc_html_e( 'MKT Publisher SEO Bridge', 'mkt-wp-publisher-seo-bridge' ); ?>
		</h1>
		<p><?php esc_html_e( 'Lets the MKT WP Publisher extension for Claude read and update SEO titles, meta descriptions, focus keywords and canonical URLs. There is nothing to configure here.', 'mkt-wp-publisher-seo-bridge' ); ?></p>
		<table class="widefat striped" style="max-width:820px;">
			<tbody>
			<?php foreach ( $rows as $row ) : ?>
				<tr>
					<th scope="row" style="width:220px;"><?php echo esc_html( $row[0] ); ?></th>
					<td>
						<span class="dashicons <?php echo $row[2] ? 'dashicons-yes-alt' : 'dashicons-warning'; ?>" style="color:<?php echo $row[2] ? '#00a32a' : '#d63638'; ?>;"></span>
						<?php echo esc_html( $row[1] ); ?>
					</td>
				</tr>
			<?php endforeach; ?>
			</tbody>
		</table>
		<h2><?php esc_html_e( 'Fields the extension can update', 'mkt-wp-publisher-seo-bridge' ); ?></h2>
		<table class="widefat striped" style="max-width:820px;">
			<thead><tr><th><?php esc_html_e( 'Field', 'mkt-wp-publisher-seo-bridge' ); ?></th><th><?php esc_html_e( 'Stored as', 'mkt-wp-publisher-seo-bridge' ); ?></th><th><?php esc_html_e( 'Max length', 'mkt-wp-publisher-seo-bridge' ); ?></th></tr></thead>
			<tbody>
			<?php foreach ( mkt_seo_bridge_limits() as $field => $max ) : ?>
				<tr>
					<td><code><?php echo esc_html( $field ); ?></code></td>
					<td><?php echo $keys ? '<code>' . esc_html( $keys[ $field ] ) . '</code>' : '&mdash;'; ?></td>
					<td><?php echo esc_html( number_format_i18n( $max ) ); ?></td>
				</tr>
			<?php endforeach; ?>
			</tbody>
		</table>
		<p class="description" style="margin-top:12px;"><?php esc_html_e( 'Only accounts that can edit a post can read or change its SEO fields. Values are saved as plain text (canonical URLs as http/https links); an empty value removes the field.', 'mkt-wp-publisher-seo-bridge' ); ?></p>
	</div>
	<?php
}
