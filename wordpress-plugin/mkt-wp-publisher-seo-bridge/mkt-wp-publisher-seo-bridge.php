<?php
/**
 * Plugin Name:       MKT Publisher SEO Bridge for Yoast & Rank Math
 * Description:       Lets the MKT WP Publisher extension for Claude read and update the SEO title, meta description, focus keyword and canonical URL of posts and pages managed by Yoast SEO or Rank Math, through the WordPress REST API.
 * Version:           1.2.2
 * Author:            Jayant
 * Requires at least: 5.6
 * Requires PHP:      7.4
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       mkt-wp-publisher-seo-bridge
 * Update URI:        false
 *
 * Adds one REST field, "mkt_seo", to every public post type (posts, pages, products, …) and taxonomy
 * (categories, tags, product categories, …), edit context only:
 *   { "plugin": "yoast" | "rank-math" | "none", "version": "1.2.2",
 *     "title": "", "description": "", "focus_keyword": "", "canonical": "" }
 * Writing it requires permission to edit that post. An empty string removes a value.
 *
 * Neither SEO plugin registers its post meta for the REST API, which is why this bridge exists.
 * For existing posts the values are saved just BEFORE WordPress saves the post, so Yoast's cached
 * "indexable" (which drives the page's <title> and meta tags) is rebuilt with the new values right away.
 * For new posts they are saved right after creation; publishing then refreshes Yoast's cache.
 *
 * Built to coexist with other plugins and custom code:
 * - Everything lives in one class guarded by class_exists(), so a second copy of the plugin (for example an
 *   old folder or a must-use copy) does nothing instead of causing a "Cannot redeclare" fatal error.
 * - It only acts on REST requests that contain "mkt_seo"; everything else passes through untouched.
 * - Read-only parts of the field ("plugin", "version") and null are ignored on writes, so clients that send
 *   back the whole post they read keep working.
 * - Errors inside its own callbacks are caught; it never breaks other REST responses or the editor.
 * - Rank Math is detected without running other plugins' autoloaders.
 * - "Update URI: false" stops WordPress from offering an unrelated wordpress.org plugin with the same
 *   folder name as an "update" for this one.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

if ( ! class_exists( 'MKT_SEO_Bridge', false ) ) {

	final class MKT_SEO_Bridge {

		const VERSION     = '1.2.2';
		const FIELD       = 'mkt_seo';
		const TEXT_DOMAIN = 'mkt-wp-publisher-seo-bridge';

		/** @var string Main plugin file, for URLs and the action link. */
		private static $file = '';

		/** @var array<int,bool> Post IDs whose SEO values were saved before the post itself (see pre_insert). */
		private static $saved_early = array();

		/** Hook into WordPress. Called once. */
		public static function boot( $file ) {
			self::$file = $file;
			add_action( 'rest_api_init', array( __CLASS__, 'register' ) );
			if ( is_admin() ) {
				add_action( 'admin_menu', array( __CLASS__, 'add_status_page' ) );
				add_filter( 'plugin_action_links_' . plugin_basename( $file ), array( __CLASS__, 'action_links' ) );
			}
		}

		/** Maximum lengths accepted, far above what search engines display, to keep stored values sane. */
		public static function limits() {
			return array(
				'title'         => 300,
				'description'   => 1000,
				'focus_keyword' => 200,
				'canonical'     => 2048,
			);
		}

		/** Meta keys for the active SEO plugin, or null when neither is active. Yoast wins if both are. */
		public static function keys() {
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
			if ( self::rank_math_active() ) {
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

		/** Rank Math, checked without triggering any autoloader (a broken third-party autoloader could throw). */
		private static function rank_math_active() {
			return defined( 'RANK_MATH_VERSION' ) || class_exists( 'RankMath', false );
		}

		/** Yoast SEO and Rank Math both active (Yoast is used). */
		public static function both_active() {
			return defined( 'WPSEO_VERSION' ) && self::rank_math_active();
		}

		/** Public post types available over the REST API: posts, pages, WooCommerce products, custom post types. */
		public static function post_types() {
			$types = function_exists( 'get_post_types' ) ? get_post_types( array( 'public' => true, 'show_in_rest' => true ), 'names' ) : array( 'post', 'page' );
			return array_values( array_diff( array_values( (array) $types ), array( 'attachment' ) ) );
		}

		/**
		 * Taxonomies editors manage in the admin and that are available over the REST API: categories, tags, product
		 * categories and tags, custom taxonomies. Not filtered on "public", so taxonomies a theme hides from the front end
		 * stay editable.
		 */
		public static function taxonomies() {
			$taxonomies = function_exists( 'get_taxonomies' ) ? get_taxonomies( array( 'show_ui' => true, 'show_in_rest' => true ), 'names' ) : array();
			return array_values( array_diff( array_values( (array) $taxonomies ), array( 'nav_menu', 'post_format', 'wp_pattern_category', 'link_category' ) ) );
		}

		/** Register the REST field and the early-save filters on post types and taxonomies. */
		public static function register() {
			foreach ( self::post_types() as $post_type ) {
				if ( ! post_type_exists( $post_type ) ) {
					continue; // Custom sites can unregister posts or pages; skip quietly.
				}
				add_filter( "rest_pre_insert_{$post_type}", array( __CLASS__, 'pre_insert' ), 10, 2 );
				register_rest_field(
					$post_type,
					self::FIELD,
					array(
						'get_callback'    => array( __CLASS__, 'get_field' ),
						'update_callback' => array( __CLASS__, 'update_field' ),
						'schema'          => self::schema(),
					)
				);
			}
			foreach ( self::taxonomies() as $taxonomy ) {
				if ( ! taxonomy_exists( $taxonomy ) ) {
					continue;
				}
				add_filter( "rest_pre_insert_{$taxonomy}", array( __CLASS__, 'pre_insert_term' ), 10, 2 );
				// WordPress's terms controller names the tags schema "tag", not "post_tag", and looks up extra fields by
				// that name; every other taxonomy uses its own name.
				register_rest_field(
					'post_tag' === $taxonomy ? 'tag' : $taxonomy,
					self::FIELD,
					array(
						'get_callback'    => array( __CLASS__, 'get_term_field' ),
						'update_callback' => array( __CLASS__, 'update_term_field' ),
						'schema'          => self::schema(),
					)
				);
			}
		}

		/** The writable part of a request value: only known fields, as strings. Null or non-objects give array(). */
		public static function editable( $value ) {
			if ( ! is_array( $value ) ) {
				return array();
			}
			return array_map( 'strval', array_intersect_key( $value, self::limits() ) );
		}

		/**
		 * Field schema. The enums tell the extension, via one OPTIONS request, which SEO plugin is active and which
		 * bridge version runs. Validation (arg_options) checks only the editable fields and ignores the read-only
		 * ones and null, so clients that send back what they read are never rejected.
		 */
		public static function schema() {
			$keys       = self::keys();
			$properties = array(
				'plugin'  => array(
					'type'     => 'string',
					'enum'     => array( $keys ? $keys['plugin'] : 'none' ),
					'readonly' => true,
				),
				'version' => array(
					'type'     => 'string',
					'enum'     => array( self::VERSION ),
					'readonly' => true,
				),
			);
			$labels     = array(
				'title'         => 'SEO title.',
				'description'   => 'Meta description.',
				'focus_keyword' => 'Focus keyword.',
				'canonical'     => 'Canonical URL (http or https).',
			);
			foreach ( self::limits() as $field => $max ) {
				$properties[ $field ] = array(
					'type'        => 'string',
					'maxLength'   => $max,
					'description' => $labels[ $field ] . ' Empty string removes it.',
				);
			}
			$properties['canonical']['pattern'] = '^(|https?://[^\\s]+)$';

			return array(
				'description' => 'SEO title, meta description, focus keyword and canonical URL (MKT Publisher SEO Bridge ' . self::VERSION . ').',
				'type'        => array( 'object', 'null' ),
				'context'     => array( 'edit' ),
				'properties'  => $properties,
				'arg_options' => array(
					'validate_callback' => array( __CLASS__, 'validate' ),
					'sanitize_callback' => array( __CLASS__, 'sanitize' ),
				),
			);
		}

		/** REST argument validation: editable fields only, against their own schema. */
		public static function validate( $value, $request = null, $param = self::FIELD ) {
			if ( null === $value ) {
				return true;
			}
			if ( ! is_array( $value ) ) {
				return new WP_Error( 'rest_invalid_type', sprintf( '%s must be an object.', $param ), array( 'status' => 400 ) );
			}
			$schema = self::schema();
			foreach ( self::editable( $value ) as $field => $text ) {
				$check = rest_validate_value_from_schema( $text, $schema['properties'][ $field ], $param . '[' . $field . ']' );
				if ( is_wp_error( $check ) ) {
					return $check;
				}
			}
			return true;
		}

		/** REST argument sanitising: keep editable fields only; null stays null. */
		public static function sanitize( $value ) {
			return null === $value ? null : self::editable( $value );
		}

		/** REST read: current values for users who can edit the post, else null. Never throws. */
		public static function get_field( $object ) {
			try {
				$post_id = isset( $object['id'] ) ? (int) $object['id'] : 0;
				if ( ! $post_id || ! current_user_can( 'edit_post', $post_id ) ) {
					return null;
				}
				$keys  = self::keys();
				$value = array(
					'plugin'  => $keys ? $keys['plugin'] : 'none',
					'version' => self::VERSION,
				);
				foreach ( array_keys( self::limits() ) as $field ) {
					$value[ $field ] = $keys ? (string) get_post_meta( $post_id, $keys[ $field ], true ) : '';
				}
				return $value;
			} catch ( \Throwable $e ) {
				return null;
			}
		}

		/**
		 * Existing posts: save the SEO values before WordPress saves the post, so Yoast's indexable is rebuilt from
		 * the new values. Runs after the REST permission check and argument validation. Anything that is not our
		 * request, or not a post object (for example another plugin's WP_Error), passes through unchanged.
		 */
		public static function pre_insert( $prepared_post, $request ) {
			// Posts always carry post_type here; a term with the same hook name (a taxonomy named like a post type) does not.
			if ( ! is_object( $prepared_post ) || is_wp_error( $prepared_post ) || empty( $prepared_post->ID ) || empty( $prepared_post->post_type ) ) {
				return $prepared_post;
			}
			if ( ! ( $request instanceof WP_REST_Request ) || ! $request->has_param( self::FIELD ) ) {
				return $prepared_post;
			}
			$value = self::editable( $request->get_param( self::FIELD ) );
			if ( ! $value ) {
				return $prepared_post;
			}
			$saved = self::save( (int) $prepared_post->ID, $value );
			if ( is_wp_error( $saved ) ) {
				return $saved; // Stops the update before the post is written.
			}
			self::$saved_early[ (int) $prepared_post->ID ] = true;
			return $prepared_post;
		}

		/** REST write after the post is saved: new posts (they have an ID only now). */
		public static function update_field( $value, $post ) {
			$post_id = is_object( $post ) && isset( $post->ID ) ? (int) $post->ID : 0;
			if ( ! $post_id ) {
				return true;
			}
			if ( ! empty( self::$saved_early[ $post_id ] ) ) {
				unset( self::$saved_early[ $post_id ] );
				return true; // Already saved before the post was saved.
			}
			$editable = self::editable( $value );
			return $editable ? self::save( $post_id, $editable ) : true;
		}

		/**
		 * Save the given SEO values for one post. Only keys present are touched; an empty string deletes.
		 *
		 * @return true|WP_Error
		 */
		public static function save( $post_id, array $value ) {
			$keys = self::keys();
			if ( ! $keys ) {
				return true; // No SEO plugin: nothing to write. The extension checks "plugin" before sending.
			}
			if ( ! current_user_can( 'edit_post', $post_id ) ) {
				return new WP_Error( 'rest_cannot_edit', __( 'Sorry, you are not allowed to edit the SEO fields of this post.', self::TEXT_DOMAIN ), array( 'status' => rest_authorization_required_code() ) );
			}
			try {
				foreach ( self::limits() as $field => $max ) {
					if ( ! array_key_exists( $field, $value ) ) {
						continue;
					}
					$text = 'canonical' === $field ? esc_url_raw( trim( $value[ $field ] ), array( 'http', 'https' ) ) : sanitize_text_field( $value[ $field ] );
					$text = function_exists( 'mb_substr' ) ? mb_substr( $text, 0, $max ) : substr( $text, 0, $max );
					if ( '' === $text ) {
						delete_post_meta( $post_id, $keys[ $field ] );
					} else {
						update_post_meta( $post_id, $keys[ $field ], wp_slash( $text ) );
					}
				}
			} catch ( \Throwable $e ) {
				return new WP_Error( 'mkt_seo_save_failed', __( 'The SEO fields could not be saved.', self::TEXT_DOMAIN ), array( 'status' => 500 ) );
			}
			return true;
		}

		/* ---------- Categories, tags and other terms ---------- */

		/** @var array<int,bool> Term IDs whose SEO values were saved before the term itself (see pre_insert_term). */
		private static $terms_saved_early = array();

		/**
		 * Where term SEO lives. Yoast keeps it in the "wpseo_taxonomy_meta" option ([taxonomy][term_id][wpseo_*]);
		 * Rank Math keeps it in term meta under the same keys it uses for posts.
		 */
		public static function term_keys() {
			$keys = self::keys();
			if ( ! $keys ) {
				return null;
			}
			if ( 'yoast' === $keys['plugin'] ) {
				return array(
					'plugin'        => 'yoast',
					'title'         => 'wpseo_title',
					'description'   => 'wpseo_desc',
					'focus_keyword' => 'wpseo_focuskw',
					'canonical'     => 'wpseo_canonical',
				);
			}
			return $keys; // Rank Math: rank_math_title, rank_math_description, … as term meta.
		}

		/** Read one SEO value of a term. */
		private static function term_value( $term_id, $taxonomy, $key ) {
			$keys = self::term_keys();
			if ( 'yoast' === $keys['plugin'] ) {
				$all = get_option( 'wpseo_taxonomy_meta', array() );
				return isset( $all[ $taxonomy ][ $term_id ][ $key ] ) && is_scalar( $all[ $taxonomy ][ $term_id ][ $key ] ) ? (string) $all[ $taxonomy ][ $term_id ][ $key ] : '';
			}
			return (string) get_term_meta( $term_id, $key, true );
		}

		/** REST read for terms: current values for users who can edit the term, else null. Never throws. */
		public static function get_term_field( $object ) {
			try {
				$term_id  = isset( $object['id'] ) ? (int) $object['id'] : 0;
				$taxonomy = isset( $object['taxonomy'] ) ? (string) $object['taxonomy'] : '';
				if ( ! $term_id || '' === $taxonomy || ! current_user_can( 'edit_term', $term_id ) ) {
					return null;
				}
				$keys  = self::term_keys();
				$value = array(
					'plugin'  => $keys ? $keys['plugin'] : 'none',
					'version' => self::VERSION,
				);
				foreach ( array_keys( self::limits() ) as $field ) {
					$value[ $field ] = $keys ? self::term_value( $term_id, $taxonomy, $keys[ $field ] ) : '';
				}
				return $value;
			} catch ( \Throwable $e ) {
				return null;
			}
		}

		/**
		 * Existing terms: save the SEO values before WordPress saves the term, so the "edited_term" save that follows
		 * refreshes Yoast's cached data from the new values. Anything else passes through unchanged.
		 */
		public static function pre_insert_term( $prepared_term, $request ) {
			if ( ! is_object( $prepared_term ) || is_wp_error( $prepared_term ) || ! empty( $prepared_term->post_type ) ) {
				return $prepared_term;
			}
			if ( ! ( $request instanceof WP_REST_Request ) || ! $request->has_param( self::FIELD ) ) {
				return $prepared_term;
			}
			$term_id = (int) $request->get_param( 'id' );
			$term    = $term_id && function_exists( 'get_term' ) ? get_term( $term_id ) : null;
			if ( ! $term || is_wp_error( $term ) || empty( $term->taxonomy ) ) {
				return $prepared_term; // New term: saved by update_term_field once it exists.
			}
			$value = self::editable( $request->get_param( self::FIELD ) );
			if ( ! $value ) {
				return $prepared_term;
			}
			$saved = self::save_term( $term_id, $term->taxonomy, $value );
			if ( is_wp_error( $saved ) ) {
				return $saved;
			}
			self::$terms_saved_early[ $term_id ] = true;
			return $prepared_term;
		}

		/** REST write after the term is saved: new terms. */
		public static function update_term_field( $value, $term ) {
			$term_id  = is_object( $term ) && isset( $term->term_id ) ? (int) $term->term_id : 0;
			$taxonomy = is_object( $term ) && isset( $term->taxonomy ) ? (string) $term->taxonomy : '';
			if ( ! $term_id || '' === $taxonomy ) {
				return true;
			}
			if ( ! empty( self::$terms_saved_early[ $term_id ] ) ) {
				unset( self::$terms_saved_early[ $term_id ] );
				return true;
			}
			$editable = self::editable( $value );
			return $editable ? self::save_term( $term_id, $taxonomy, $editable ) : true;
		}

		/**
		 * Save SEO values for one term. Only keys present are touched; an empty string deletes.
		 *
		 * @return true|WP_Error
		 */
		public static function save_term( $term_id, $taxonomy, array $value ) {
			$keys = self::term_keys();
			if ( ! $keys ) {
				return true;
			}
			if ( ! current_user_can( 'edit_term', $term_id ) ) {
				return new WP_Error( 'rest_cannot_edit', __( 'Sorry, you are not allowed to edit the SEO fields of this term.', self::TEXT_DOMAIN ), array( 'status' => rest_authorization_required_code() ) );
			}
			try {
				$clean = array();
				foreach ( self::limits() as $field => $max ) {
					if ( ! array_key_exists( $field, $value ) ) {
						continue;
					}
					$text            = 'canonical' === $field ? esc_url_raw( trim( $value[ $field ] ), array( 'http', 'https' ) ) : sanitize_text_field( $value[ $field ] );
					$clean[ $field ] = function_exists( 'mb_substr' ) ? mb_substr( $text, 0, $max ) : substr( $text, 0, $max );
				}
				if ( 'yoast' === $keys['plugin'] ) {
					$all = get_option( 'wpseo_taxonomy_meta', array() );
					$all = is_array( $all ) ? $all : array();
					foreach ( $clean as $field => $text ) {
						if ( '' === $text ) {
							unset( $all[ $taxonomy ][ $term_id ][ $keys[ $field ] ] );
						} else {
							$all[ $taxonomy ][ $term_id ][ $keys[ $field ] ] = $text;
						}
					}
					update_option( 'wpseo_taxonomy_meta', $all );
				} else {
					foreach ( $clean as $field => $text ) {
						if ( '' === $text ) {
							delete_term_meta( $term_id, $keys[ $field ] );
						} else {
							update_term_meta( $term_id, $keys[ $field ], wp_slash( $text ) );
						}
					}
				}
			} catch ( \Throwable $e ) {
				return new WP_Error( 'mkt_seo_save_failed', __( 'The SEO fields could not be saved.', self::TEXT_DOMAIN ), array( 'status' => 500 ) );
			}
			return true;
		}

		/* ---------- Admin: Tools > MKT SEO Bridge status page ---------- */

		public static function add_status_page() {
			add_management_page(
				__( 'MKT Publisher SEO Bridge', self::TEXT_DOMAIN ),
				__( 'MKT SEO Bridge', self::TEXT_DOMAIN ),
				'manage_options',
				'mkt-seo-bridge',
				array( __CLASS__, 'render_status_page' )
			);
		}

		public static function action_links( $links ) {
			if ( ! is_array( $links ) ) {
				return $links;
			}
			array_unshift( $links, '<a href="' . esc_url( admin_url( 'tools.php?page=mkt-seo-bridge' ) ) . '">' . esc_html__( 'Status', self::TEXT_DOMAIN ) . '</a>' );
			return $links;
		}

		public static function render_status_page() {
			if ( ! current_user_can( 'manage_options' ) ) {
				return;
			}
			$keys     = self::keys();
			$app_pass = function_exists( 'wp_is_application_passwords_available' ) ? wp_is_application_passwords_available() : true;
			$plugin   = $keys
				? $keys['name'] . ( self::both_active() ? ' ' . __( '(Yoast SEO and Rank Math are both active; Yoast SEO is used)', self::TEXT_DOMAIN ) : '' )
				: __( 'None found. Activate Yoast SEO or Rank Math.', self::TEXT_DOMAIN );
			$rows     = array(
				array( __( 'Bridge version', self::TEXT_DOMAIN ), self::VERSION, true ),
				array( __( 'SEO plugin', self::TEXT_DOMAIN ), $plugin, (bool) $keys ),
				array( __( 'REST field', self::TEXT_DOMAIN ), self::FIELD . ' ' . __( 'on posts and pages', self::TEXT_DOMAIN ), true ),
				array(
					__( 'Application Passwords', self::TEXT_DOMAIN ),
					$app_pass ? __( 'Available', self::TEXT_DOMAIN ) : __( 'Disabled on this site (a security plugin or setting may block them). The extension cannot log in until they are allowed.', self::TEXT_DOMAIN ),
					$app_pass,
				),
			);
			$icon     = plugins_url( 'assets/icon-128x128.png', self::$file );
			?>
			<div class="wrap">
				<h1 style="display:flex;align-items:center;gap:12px;">
					<img src="<?php echo esc_url( $icon ); ?>" width="48" height="48" alt="" style="border-radius:10px;" />
					<?php esc_html_e( 'MKT Publisher SEO Bridge', self::TEXT_DOMAIN ); ?>
				</h1>
				<p><?php esc_html_e( 'Lets the MKT WP Publisher extension for Claude read and update SEO titles, meta descriptions, focus keywords and canonical URLs. There is nothing to configure here.', self::TEXT_DOMAIN ); ?></p>
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
				<h2><?php esc_html_e( 'Fields the extension can update', self::TEXT_DOMAIN ); ?></h2>
				<table class="widefat striped" style="max-width:820px;">
					<thead><tr><th><?php esc_html_e( 'Field', self::TEXT_DOMAIN ); ?></th><th><?php esc_html_e( 'Stored as', self::TEXT_DOMAIN ); ?></th><th><?php esc_html_e( 'Max length', self::TEXT_DOMAIN ); ?></th></tr></thead>
					<tbody>
					<?php foreach ( self::limits() as $field => $max ) : ?>
						<tr>
							<td><code><?php echo esc_html( $field ); ?></code></td>
							<td><?php echo $keys ? '<code>' . esc_html( $keys[ $field ] ) . '</code>' : '&mdash;'; ?></td>
							<td><?php echo esc_html( number_format_i18n( $max ) ); ?></td>
						</tr>
					<?php endforeach; ?>
					</tbody>
				</table>
				<p class="description" style="margin-top:12px;"><?php esc_html_e( 'Only accounts that can edit a post can read or change its SEO fields. Values are saved as plain text (canonical URLs as http/https links); an empty value removes the field.', self::TEXT_DOMAIN ); ?></p>
			</div>
			<?php
		}
	}

	MKT_SEO_Bridge::boot( __FILE__ );
}
