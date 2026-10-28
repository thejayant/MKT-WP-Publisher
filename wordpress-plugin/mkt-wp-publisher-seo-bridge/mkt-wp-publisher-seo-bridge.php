<?php
/**
 * Plugin Name:       MKT Publisher SEO Bridge for Yoast & Rank Math
 * Description:       Lets WP Publisher (for Claude and for ChatGPT) read and update the SEO title, meta description, focus keyword and canonical URL of posts and pages managed by Yoast SEO, Rank Math, All in One SEO or SEOPress, and their Advanced Custom Fields, through the WordPress REST API.
 * Version:           1.5.0
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
 *   { "plugin": "yoast" | "rank-math" | "aioseo" | "seopress" | "none", "version": "1.4.0",
 *     "title": "", "description": "", "focus_keyword": "", "canonical": "" }
 * Writing it requires permission to edit that post. An empty string removes a value.
 *
 * From 1.3.0 a second field, "mkt_fields", exposes custom fields on the same post types and taxonomies: the
 * Advanced Custom Fields shown on that item (values plus definitions: type, sub fields, layouts, choices) and any
 * post/term meta keys an administrator lists under Tools > MKT SEO Bridge. It is computed only for requests that
 * ask for it (?mkt_fields=1, or a write that contains it), so the editor and other REST clients never pay for it.
 * Writes send whole top-level values: { "fields": { "name": value }, "meta": { "key": "text" } }. Every value is
 * checked against the field definition before anything is saved; unknown or read-only fields are refused.
 *
 * From 1.4.0 All in One SEO (posts and pages; it keeps them in its own aioseo_posts table) and SEOPress (post meta,
 * and term meta for categories and tags) are supported too. Yoast SEO, then Rank Math, then All in One SEO, then
 * SEOPress is used when more than one is active, so sites with Yoast or Rank Math behave exactly as before.
 * 1.4.0 also adds a read-only "mkt_builder" field: the page builder (Elementor, Bricks, Divi, WPBakery…) that owns a
 * post's layout, read from the builder's own post meta, so the extension does not overwrite builder pages.
 *
 * From 1.5.0 a field "mkt_elementor" reads and writes Elementor layouts (Elementor 3.0+), only for requests that ask
 * for it (?mkt_elementor=1, or a write containing it). Writes are checked first (element ids, nesting, registered
 * widgets, page settings) and then saved through Elementor's own Document::save(), so Elementor regenerates its CSS,
 * records its version and keeps revisions. A page another user has open in an editor is never written.
 * 1.5.0 also adds the "editor queue" (REST namespace mkt-seo-bridge/v1): the extension can leave a proposed new
 * version of a post's block content, and a small script in the block editor offers it to whoever has the post open,
 * with Apply and Dismiss buttons. Applying changes only the editor; the person reviews it and saves.
 *
 * None of these SEO plugins registers its post meta for the REST API, which is why this bridge exists.
 * For existing posts the values are saved just BEFORE WordPress saves the post, so Yoast's cached
 * "indexable" (which drives the page's <title> and meta tags) is rebuilt with the new values right away.
 * For new posts they are saved right after creation; publishing then refreshes Yoast's cache.
 *
 * Built to coexist with other plugins and custom code:
 * - Everything lives in one class guarded by class_exists(), so a second copy of the plugin (for example an
 *   old folder or a must-use copy) does nothing instead of causing a "Cannot redeclare" fatal error.
 * - It only acts on REST requests that contain "mkt_seo" or "mkt_fields"; everything else passes through untouched.
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

		const VERSION     = '1.5.0';
		const FIELD       = 'mkt_seo';
		const BUILDER     = 'mkt_builder';
		const TEXT_DOMAIN = 'mkt-wp-publisher-seo-bridge';

		/** @var string Main plugin file, for URLs and the action link. */
		private static $file = '';

		/** @var array<int,bool> Post IDs whose SEO values were saved before the post itself (see pre_insert). */
		private static $saved_early = array();

		/** Hook into WordPress. Called once. */
		public static function boot( $file ) {
			self::$file = $file;
			add_action( 'rest_api_init', array( __CLASS__, 'register' ) );
			add_action( 'enqueue_block_editor_assets', array( __CLASS__, 'enqueue_editor_queue' ) );
			if ( is_admin() ) {
				add_action( 'admin_menu', array( __CLASS__, 'add_status_page' ) );
				add_action( 'admin_post_mkt_fields_save_meta_keys', array( __CLASS__, 'save_meta_keys' ) );
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

		/**
		 * Meta keys for the active SEO plugin, or null when none is active. Order of preference: Yoast SEO, Rank Math,
		 * All in One SEO, SEOPress. All in One SEO keeps its values in its own table: its "keys" are column names and
		 * "storage" is "aioseo".
		 */
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
			if ( self::aioseo_active() ) {
				return array(
					'plugin'        => 'aioseo',
					'name'          => 'All in One SEO',
					'storage'       => 'aioseo',
					'title'         => 'title',
					'description'   => 'description',
					'focus_keyword' => 'keyphrases',
					'canonical'     => 'canonical_url',
				);
			}
			if ( defined( 'SEOPRESS_VERSION' ) ) {
				return array(
					'plugin'        => 'seopress',
					'name'          => 'SEOPress',
					'title'         => '_seopress_titles_title',
					'description'   => '_seopress_titles_desc',
					'focus_keyword' => '_seopress_analysis_target_kw',
					'canonical'     => '_seopress_robots_canonical',
				);
			}
			return null;
		}

		/** All in One SEO (4.x), checked without running its code. */
		private static function aioseo_active() {
			return defined( 'AIOSEO_VERSION' ) || function_exists( 'aioseo' );
		}

		/** Names of every active SEO plugin this bridge knows, in order of preference. */
		public static function active_seo_plugins() {
			$names = array();
			if ( defined( 'WPSEO_VERSION' ) ) {
				$names[] = 'Yoast SEO';
			}
			if ( self::rank_math_active() ) {
				$names[] = 'Rank Math';
			}
			if ( self::aioseo_active() ) {
				$names[] = 'All in One SEO';
			}
			if ( defined( 'SEOPRESS_VERSION' ) ) {
				$names[] = 'SEOPress';
			}
			return $names;
		}

		/** One SEO value of a post, from post meta or All in One SEO's table. */
		private static function post_value( $post_id, array $keys, $field ) {
			if ( isset( $keys['storage'] ) && 'aioseo' === $keys['storage'] ) {
				return self::aioseo_value( $post_id, $field );
			}
			return (string) get_post_meta( $post_id, $keys[ $field ], true );
		}

		/* ---------- All in One SEO: values live in {prefix}aioseo_posts ---------- */

		/** @var string|null|false The aioseo_posts table name, false when it does not exist, null before the first check. */
		private static $aioseo_table = null;

		private static function aioseo_table() {
			global $wpdb;
			if ( null === self::$aioseo_table ) {
				$table              = $wpdb->prefix . 'aioseo_posts';
				self::$aioseo_table = $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $wpdb->esc_like( $table ) ) ) === $table ? $table : false;
			}
			return self::$aioseo_table;
		}

		private static function aioseo_row( $post_id ) {
			global $wpdb;
			$table = self::aioseo_table();
			if ( ! $table ) {
				return null;
			}
			// The table name comes from $wpdb->prefix, not from the request.
			$row = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM `{$table}` WHERE post_id = %d LIMIT 1", $post_id ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			return is_array( $row ) ? $row : null;
		}

		/** The focus keyphrase is stored as JSON: {"focus":{"keyphrase":"…","score":0,"analysis":{}},"additional":[]}. */
		private static function aioseo_keyphrases( $row ) {
			$data = $row && isset( $row['keyphrases'] ) ? json_decode( (string) $row['keyphrases'] ) : null;
			return is_object( $data ) ? $data : (object) array( 'focus' => (object) array(), 'additional' => array() );
		}

		private static function aioseo_value( $post_id, $field ) {
			$row = self::aioseo_row( $post_id );
			if ( ! $row ) {
				return '';
			}
			if ( 'focus_keyword' === $field ) {
				$data = self::aioseo_keyphrases( $row );
				return isset( $data->focus->keyphrase ) && is_scalar( $data->focus->keyphrase ) ? (string) $data->focus->keyphrase : '';
			}
			$column = 'canonical' === $field ? 'canonical_url' : $field;
			return isset( $row[ $column ] ) && is_scalar( $row[ $column ] ) ? (string) $row[ $column ] : '';
		}

		/**
		 * Save cleaned SEO values to All in One SEO's row for the post, creating the row if it has none yet. An empty
		 * value is stored as NULL, which All in One SEO reads as "use the default".
		 *
		 * @return true|WP_Error
		 */
		private static function aioseo_save( $post_id, array $clean ) {
			global $wpdb;
			$table = self::aioseo_table();
			if ( ! $table ) {
				return new WP_Error( 'mkt_seo_save_failed', __( 'All in One SEO is active but its data table was not found. Open All in One SEO once in wp-admin so it can finish installing, then retry.', self::TEXT_DOMAIN ), array( 'status' => 500 ) );
			}
			$row  = self::aioseo_row( $post_id );
			$data = array();
			foreach ( $clean as $field => $text ) {
				if ( 'focus_keyword' === $field ) {
					$phrases = self::aioseo_keyphrases( $row );
					if ( ! isset( $phrases->focus ) || ! is_object( $phrases->focus ) ) {
						$phrases->focus = (object) array();
					}
					$phrases->focus->keyphrase = $text;
					if ( ! isset( $phrases->focus->score ) ) {
						$phrases->focus->score = 0;
					}
					if ( ! isset( $phrases->focus->analysis ) ) {
						$phrases->focus->analysis = (object) array();
					}
					if ( ! isset( $phrases->additional ) ) {
						$phrases->additional = array();
					}
					$data['keyphrases'] = wp_json_encode( $phrases );
				} else {
					$data[ 'canonical' === $field ? 'canonical_url' : $field ] = '' === $text ? null : $text;
				}
			}
			if ( ! $data ) {
				return true;
			}
			$data['updated'] = gmdate( 'Y-m-d H:i:s' );
			if ( $row ) {
				$done = $wpdb->update( $table, $data, array( 'post_id' => $post_id ) );
			} else {
				$data['post_id'] = $post_id;
				$data['created'] = $data['updated'];
				$done            = $wpdb->insert( $table, $data );
			}
			if ( false === $done ) {
				return new WP_Error( 'mkt_seo_save_failed', __( 'The All in One SEO fields could not be saved.', self::TEXT_DOMAIN ), array( 'status' => 500 ) );
			}
			return true;
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
				register_rest_field(
					$post_type,
					self::FIELDS,
					array(
						'get_callback'    => array( __CLASS__, 'get_post_fields' ),
						'update_callback' => array( __CLASS__, 'update_post_fields' ),
						'schema'          => self::fields_schema( 'post' ),
					)
				);
				register_rest_field(
					$post_type,
					self::BUILDER,
					array(
						'get_callback' => array( __CLASS__, 'get_builder' ),
						'schema'       => self::builder_schema(),
					)
				);
				register_rest_field(
					$post_type,
					self::ELEMENTOR,
					array(
						'get_callback'    => array( __CLASS__, 'get_elementor' ),
						'update_callback' => array( __CLASS__, 'update_elementor' ),
						'schema'          => self::elementor_schema(),
					)
				);
			}
			self::register_queue_routes();
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
						'schema'          => self::schema( 'term' ),
					)
				);
				register_rest_field(
					'post_tag' === $taxonomy ? 'tag' : $taxonomy,
					self::FIELDS,
					array(
						'get_callback'    => array( __CLASS__, 'get_term_fields' ),
						'update_callback' => array( __CLASS__, 'update_term_fields' ),
						'schema'          => self::fields_schema( 'term' ),
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
		 * ones and null, so clients that send back what they read are never rejected. For terms, "plugin" is the
		 * plugin whose term SEO the bridge can write ("none" for All in One SEO, which keeps term SEO in its Pro version).
		 */
		public static function schema( $kind = 'post' ) {
			$keys       = 'term' === $kind ? self::term_keys() : self::keys();
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
					$value[ $field ] = $keys ? self::post_value( $post_id, $keys, $field ) : '';
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
				if ( isset( $keys['storage'] ) && 'aioseo' === $keys['storage'] ) {
					$clean = array();
					foreach ( self::limits() as $field => $max ) {
						if ( array_key_exists( $field, $value ) ) {
							$text            = 'canonical' === $field ? esc_url_raw( trim( $value[ $field ] ), array( 'http', 'https' ) ) : sanitize_text_field( $value[ $field ] );
							$clean[ $field ] = function_exists( 'mb_substr' ) ? mb_substr( $text, 0, $max ) : substr( $text, 0, $max );
						}
					}
					return self::aioseo_save( $post_id, $clean );
				}
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

		/* ---------- Page builder of a post (read-only) ---------- */

		/**
		 * Builders and the post meta each one sets on posts it owns: [id, name, where the layout is stored, meta key,
		 * expected value or null for "any non-empty value"]. "meta": the layout lives in the builder's own data and
		 * post_content is only a copy; "content": the layout is shortcodes or blocks inside post_content.
		 */
		private static function builders() {
			return array(
				array( 'elementor', 'Elementor', 'meta', '_elementor_edit_mode', 'builder' ),
				array( 'bricks', 'Bricks', 'meta', '_bricks_editor_mode', 'bricks' ),
				array( 'beaver-builder', 'Beaver Builder', 'meta', '_fl_builder_enabled', null ),
				array( 'breakdance', 'Breakdance', 'meta', '_breakdance_data', null ),
				array( 'oxygen', 'Oxygen', 'meta', 'ct_builder_shortcodes', null ),
				array( 'oxygen', 'Oxygen', 'meta', '_oxygen_data', null ),
				array( 'divi', 'Divi', 'content', '_et_pb_use_builder', 'on' ),
				array( 'wpbakery', 'WPBakery Page Builder', 'content', '_wpb_vc_js_status', 'true' ),
				array( 'avada', 'Avada Fusion Builder', 'content', 'fusion_builder_status', 'active' ),
			);
		}

		public static function builder_schema() {
			return array(
				'description' => 'Page builder that owns this item\'s layout, or null (MKT Publisher SEO Bridge ' . self::VERSION . ').',
				'type'        => array( 'object', 'null' ),
				'context'     => array( 'edit' ),
				'readonly'    => true,
				'properties'  => array(
					'id'      => array( 'type' => 'string' ),
					'name'    => array( 'type' => 'string' ),
					'storage' => array(
						'type' => 'string',
						'enum' => array( 'meta', 'content' ),
					),
				),
			);
		}

		/** REST read: the builder that owns the post's layout, or null. Only for users who can edit it. Never throws. */
		public static function get_builder( $object ) {
			try {
				$post_id = isset( $object['id'] ) ? (int) $object['id'] : 0;
				if ( ! $post_id || ! current_user_can( 'edit_post', $post_id ) ) {
					return null;
				}
				foreach ( self::builders() as $builder ) {
					$value = get_post_meta( $post_id, $builder[3], true );
					$found = null === $builder[4]
						? ! empty( $value ) && '0' !== $value && 'false' !== $value
						: is_scalar( $value ) && (string) $value === $builder[4];
					if ( $found ) {
						return array(
							'id'      => $builder[0],
							'name'    => $builder[1],
							'storage' => $builder[2],
						);
					}
				}
				return null;
			} catch ( \Throwable $e ) {
				return null;
			}
		}

		/* ---------- Categories, tags and other terms ---------- */

		/** @var array<int,bool> Term IDs whose SEO values were saved before the term itself (see pre_insert_term). */
		private static $terms_saved_early = array();

		/**
		 * Where term SEO lives. Yoast keeps it in the "wpseo_taxonomy_meta" option ([taxonomy][term_id][wpseo_*]);
		 * Rank Math and SEOPress keep it in term meta under the same keys they use for posts. All in One SEO keeps
		 * term SEO only in its Pro version's own table, which the bridge does not write, so terms report no plugin.
		 */
		public static function term_keys() {
			$keys = self::keys();
			if ( ! $keys || 'aioseo' === $keys['plugin'] ) {
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

		/* ---------- Custom fields: Advanced Custom Fields and listed meta keys ("mkt_fields") ---------- */

		const FIELDS           = 'mkt_fields';
		const META_KEYS_OPTION = 'mkt_fields_meta_keys';

		/** ACF field types that can be written. Others (tab, message, accordion, clone, google_map, password, …) are read-only. */
		public static function writable_types() {
			return array( 'text', 'textarea', 'wysiwyg', 'email', 'url', 'number', 'range', 'image', 'file', 'gallery', 'true_false', 'select', 'radio', 'checkbox', 'button_group', 'date_picker', 'date_time_picker', 'time_picker', 'color_picker', 'link', 'oembed', 'post_object', 'page_link', 'relationship', 'taxonomy', 'user', 'group', 'repeater', 'flexible_content' );
		}

		/** Text-like types whose HTML is filtered for accounts without the unfiltered_html capability. */
		private static function text_types() {
			return array( 'text', 'textarea', 'wysiwyg', 'oembed' );
		}

		/** Advanced Custom Fields (free or Pro) with the functions the bridge uses, checked without autoloading. */
		public static function acf_active() {
			return function_exists( 'acf_get_field_groups' ) && function_exists( 'acf_get_fields' ) && function_exists( 'acf_get_value' ) && function_exists( 'update_field' );
		}

		/** Field schema. The "source" and "version" enums tell the extension, via OPTIONS, what this site supports. */
		public static function fields_schema( $kind ) {
			return array(
				'description' => 'Custom fields (Advanced Custom Fields and listed meta keys) for MKT WP Publisher (SEO Bridge ' . self::VERSION . '). Read with ?mkt_fields=1.',
				'type'        => array( 'object', 'null' ),
				'context'     => array( 'edit' ),
				'properties'  => array(
					'source'  => array(
						'type'     => 'string',
						'enum'     => array( self::acf_active() ? 'acf' : 'none' ),
						'readonly' => true,
					),
					'version' => array(
						'type'     => 'string',
						'enum'     => array( self::VERSION ),
						'readonly' => true,
					),
					'fields'  => array( 'type' => 'object' ),
					'meta'    => array( 'type' => 'object' ),
				),
				'arg_options' => array(
					'validate_callback' => array( __CLASS__, 'term' === $kind ? 'validate_term_fields' : 'validate_post_fields' ),
					'sanitize_callback' => array( __CLASS__, 'sanitize_fields' ),
				),
			);
		}

		/** Meta keys an administrator made editable (Tools > MKT SEO Bridge), plus any added with the mkt_fields_meta_keys filter. */
		public static function meta_keys( $kind = 'post' ) {
			$keys = get_option( self::META_KEYS_OPTION, array() );
			$keys = apply_filters( 'mkt_fields_meta_keys', is_array( $keys ) ? $keys : array(), $kind );
			$out  = array();
			foreach ( (array) $keys as $key ) {
				if ( is_string( $key ) && self::meta_key_allowed( trim( $key ) ) ) {
					$out[] = trim( $key );
				}
			}
			return array_values( array_unique( $out ) );
		}

		/** A plain meta key that is not one of WordPress's own internal keys. */
		public static function meta_key_allowed( $key ) {
			return is_string( $key ) && 1 === preg_match( '/^[A-Za-z0-9_\-]{1,190}$/', $key ) && 0 !== strpos( $key, '_wp_' ) && 0 !== strpos( $key, '_edit_' );
		}

		/** Only requests that ask for the fields (?mkt_fields=1) or write them get them, so other requests stay as fast as before. */
		private static function wants_fields( $request ) {
			return $request instanceof WP_REST_Request && $request->has_param( self::FIELDS );
		}

		/** REST read on posts. Never throws. */
		public static function get_post_fields( $object, $field_name = '', $request = null ) {
			try {
				$post_id = isset( $object['id'] ) ? (int) $object['id'] : 0;
				if ( ! $post_id || ! self::wants_fields( $request ) || ! current_user_can( 'edit_post', $post_id ) ) {
					return null;
				}
				return self::read_fields( 'post', $post_id, '' );
			} catch ( \Throwable $e ) {
				return null;
			}
		}

		/** REST read on terms. Never throws. */
		public static function get_term_fields( $object, $field_name = '', $request = null ) {
			try {
				$term_id  = isset( $object['id'] ) ? (int) $object['id'] : 0;
				$taxonomy = isset( $object['taxonomy'] ) ? (string) $object['taxonomy'] : '';
				if ( ! $term_id || '' === $taxonomy || ! self::wants_fields( $request ) || ! current_user_can( 'edit_term', $term_id ) ) {
					return null;
				}
				return self::read_fields( 'term', $term_id, $taxonomy );
			} catch ( \Throwable $e ) {
				return null;
			}
		}

		/**
		 * The ACF object ID of a post or term and the definitions of the fields shown on it, by name. ACF's own location
		 * rules decide which field groups apply (post type, page template, taxonomy, …). A name already taken by an
		 * earlier group is not replaced.
		 */
		private static function definitions( $kind, $id, $taxonomy ) {
			if ( ! self::acf_active() ) {
				return array( null, array() );
			}
			if ( 'term' === $kind ) {
				$acf_id = 'term_' . $id;
				$groups = acf_get_field_groups( array( 'taxonomy' => $taxonomy ) );
			} else {
				$acf_id = $id;
				$groups = acf_get_field_groups(
					array(
						'post_id'   => $id,
						'post_type' => get_post_type( $id ),
					)
				);
			}
			$fields = array();
			foreach ( (array) $groups as $group ) {
				foreach ( (array) acf_get_fields( $group ) as $field ) {
					if ( is_array( $field ) && ! empty( $field['name'] ) && ! empty( $field['key'] ) && ! isset( $fields[ $field['name'] ] ) ) {
						$fields[ $field['name'] ] = $field;
					}
				}
			}
			return array( $acf_id, $fields );
		}

		/** Current values and definitions of every field and listed meta key on one post or term. */
		private static function read_fields( $kind, $id, $taxonomy ) {
			list( $acf_id, $fields ) = self::definitions( $kind, $id, $taxonomy );
			$out                     = array(
				'source'      => self::acf_active() ? 'acf' : 'none',
				'version'     => self::VERSION,
				'acf_version' => defined( 'ACF_VERSION' ) ? (string) ACF_VERSION : '',
				'fields'      => array(),
				'meta'        => array(),
			);
			foreach ( $fields as $name => $field ) {
				$out['fields'][ $name ] = self::describe( $field ) + array( 'value' => self::normalize( $field, acf_get_value( $acf_id, $field ) ) );
			}
			foreach ( self::meta_keys( $kind ) as $key ) {
				$value               = 'term' === $kind ? get_term_meta( $id, $key, true ) : get_post_meta( $id, $key, true );
				$out['meta'][ $key ] = array(
					'value'    => $value,
					'writable' => is_scalar( $value ),
				);
			}
			return $out;
		}

		/** A field's definition for the extension: type, whether it can be written, sub fields, layouts, choices. */
		private static function describe( $field ) {
			$type = (string) $field['type'];
			$out  = array(
				'key'      => (string) $field['key'],
				'label'    => isset( $field['label'] ) ? (string) $field['label'] : '',
				'type'     => $type,
				'writable' => in_array( $type, self::writable_types(), true ),
			);
			if ( ! empty( $field['required'] ) ) {
				$out['required'] = true;
			}
			if ( ! empty( $field['choices'] ) && is_array( $field['choices'] ) ) {
				$out['choices'] = array_map( 'strval', array_keys( $field['choices'] ) );
			}
			if ( 'select' === $type && ! empty( $field['multiple'] ) ) {
				$out['multiple'] = true;
			}
			if ( 'group' === $type || 'repeater' === $type ) {
				$out['sub_fields'] = self::describe_all( self::sub_fields( $field ) );
			}
			if ( 'flexible_content' === $type ) {
				$out['layouts'] = array();
				foreach ( (array) ( $field['layouts'] ?? array() ) as $layout ) {
					if ( is_array( $layout ) && ! empty( $layout['name'] ) ) {
						$out['layouts'][ $layout['name'] ] = array(
							'label'      => isset( $layout['label'] ) ? (string) $layout['label'] : '',
							'sub_fields' => self::describe_all( (array) ( $layout['sub_fields'] ?? array() ) ),
						);
					}
				}
			}
			if ( 'repeater' === $type || 'flexible_content' === $type ) {
				foreach ( array( 'min', 'max' ) as $limit ) {
					if ( ! empty( $field[ $limit ] ) ) {
						$out[ $limit ] = (int) $field[ $limit ];
					}
				}
			}
			return $out;
		}

		private static function describe_all( $fields ) {
			$out = array();
			foreach ( (array) $fields as $sub ) {
				if ( is_array( $sub ) && ! empty( $sub['name'] ) && ! empty( $sub['key'] ) ) {
					$out[ $sub['name'] ] = self::describe( $sub );
				}
			}
			return $out;
		}

		/** Sub fields of a group or repeater, or of one flexible content layout (null if the layout does not exist). */
		private static function sub_fields( $field, $layout_name = null ) {
			if ( 'flexible_content' === $field['type'] ) {
				foreach ( (array) ( $field['layouts'] ?? array() ) as $layout ) {
					if ( is_array( $layout ) && isset( $layout['name'] ) && (string) $layout['name'] === (string) $layout_name ) {
						return (array) ( $layout['sub_fields'] ?? array() );
					}
				}
				return null;
			}
			return (array) ( $field['sub_fields'] ?? array() );
		}

		/** ACF's stored value with sub fields keyed by name instead of field key (repeaters and layouts as lists of rows). */
		private static function normalize( $field, $raw ) {
			switch ( $field['type'] ) {
				case 'group':
					return self::normalize_row( self::sub_fields( $field ), is_array( $raw ) ? $raw : array() );
				case 'repeater':
					$rows = array();
					foreach ( is_array( $raw ) ? $raw : array() as $row ) {
						if ( is_array( $row ) ) {
							$rows[] = self::normalize_row( self::sub_fields( $field ), $row );
						}
					}
					return $rows;
				case 'flexible_content':
					$rows = array();
					foreach ( is_array( $raw ) ? $raw : array() as $row ) {
						if ( is_array( $row ) && ! empty( $row['acf_fc_layout'] ) ) {
							$subs   = self::sub_fields( $field, $row['acf_fc_layout'] );
							$rows[] = array( 'acf_fc_layout' => (string) $row['acf_fc_layout'] ) + self::normalize_row( $subs ? $subs : array(), $row );
						}
					}
					return $rows;
			}
			return $raw;
		}

		private static function normalize_row( $subs, $row ) {
			$out = array();
			foreach ( (array) $subs as $sub ) {
				if ( ! is_array( $sub ) || empty( $sub['name'] ) || empty( $sub['key'] ) ) {
					continue;
				}
				$raw                 = array_key_exists( $sub['key'], $row ) ? $row[ $sub['key'] ] : ( $row[ $sub['name'] ] ?? null );
				$out[ $sub['name'] ] = self::normalize( $sub, $raw );
			}
			return $out;
		}

		/** REST argument validation on posts: every value is checked against its field definition before anything is saved. */
		public static function validate_post_fields( $value, $request = null, $param = self::FIELDS ) {
			return self::validate_request( 'post', $value, $request, $param );
		}

		public static function validate_term_fields( $value, $request = null, $param = self::FIELDS ) {
			return self::validate_request( 'term', $value, $request, $param );
		}

		private static function validate_request( $kind, $value, $request, $param ) {
			if ( null === $value ) {
				return true;
			}
			if ( ! is_array( $value ) ) {
				return new WP_Error( 'rest_invalid_type', sprintf( '%s must be an object.', $param ), array( 'status' => 400 ) );
			}
			foreach ( array( 'fields', 'meta' ) as $part ) {
				if ( isset( $value[ $part ] ) && ! is_array( $value[ $part ] ) ) {
					return self::invalid( sprintf( '%s.%s must be an object.', $param, $part ) );
				}
			}
			try {
				$changes = self::sanitize_fields( $value );
				if ( ! $changes['fields'] && ! $changes['meta'] ) {
					return true; // Only read-only parts were sent back.
				}
				$id = $request instanceof WP_REST_Request ? (int) $request->get_param( 'id' ) : 0;
				if ( ! $id ) {
					return self::invalid( sprintf( '%s can only be written to an existing item.', $param ) );
				}
				$plan = self::plan( $kind, $id, 'term' === $kind ? self::term_taxonomy( $id ) : '', $changes, $param );
				return is_wp_error( $plan ) ? $plan : true;
			} catch ( \Throwable $e ) {
				return new WP_Error( 'mkt_fields_check_failed', __( 'The custom fields could not be checked.', self::TEXT_DOMAIN ), array( 'status' => 500 ) );
			}
		}

		/** REST argument sanitising: the writable parts only; null stays null. Values are checked and cleaned in plan(). */
		public static function sanitize_fields( $value ) {
			if ( null === $value ) {
				return null;
			}
			$value = is_array( $value ) ? $value : array();
			return array(
				'fields' => isset( $value['fields'] ) && is_array( $value['fields'] ) ? $value['fields'] : array(),
				'meta'   => isset( $value['meta'] ) && is_array( $value['meta'] ) ? $value['meta'] : array(),
			);
		}

		private static function term_taxonomy( $term_id ) {
			$term = function_exists( 'get_term' ) ? get_term( $term_id ) : null;
			return $term && ! is_wp_error( $term ) && ! empty( $term->taxonomy ) ? (string) $term->taxonomy : '';
		}

		private static function invalid( $message ) {
			return new WP_Error( 'mkt_fields_invalid', $message, array( 'status' => 400 ) );
		}

		/**
		 * Check every requested change and turn it into what ACF stores (sub fields keyed by field key, HTML filtered).
		 *
		 * @return array|WP_Error {acf_id, fields: [[field, value]], meta: [key => text|null]}
		 */
		private static function plan( $kind, $id, $taxonomy, array $changes, $param ) {
			$ops = array(
				'acf_id' => null,
				'fields' => array(),
				'meta'   => array(),
			);
			if ( $changes['fields'] ) {
				if ( ! self::acf_active() ) {
					return self::invalid( __( 'Advanced Custom Fields is not active on this site, so no custom fields can be written.', self::TEXT_DOMAIN ) );
				}
				list( $acf_id, $defs ) = self::definitions( $kind, $id, $taxonomy );
				$ops['acf_id']         = $acf_id;
				foreach ( $changes['fields'] as $name => $new ) {
					$name = (string) $name;
					if ( ! isset( $defs[ $name ] ) ) {
						return self::invalid( sprintf( '%s: there is no custom field "%s" on this item.', $param, $name ) );
					}
					$checked = self::check_value( $defs[ $name ], $new, $param . '.' . $name );
					if ( is_wp_error( $checked ) ) {
						return $checked;
					}
					$ops['fields'][] = array( $defs[ $name ], self::to_acf( $defs[ $name ], $new ) );
				}
			}
			$allowed = $changes['meta'] ? self::meta_keys( $kind ) : array();
			foreach ( $changes['meta'] as $key => $new ) {
				$key = (string) $key;
				if ( ! in_array( $key, $allowed, true ) ) {
					return self::invalid( sprintf( '%s: meta key "%s" is not in the list of editable meta keys (Tools > MKT SEO Bridge).', $param, $key ) );
				}
				if ( null !== $new && ! is_scalar( $new ) ) {
					return self::invalid( sprintf( '%s.meta.%s must be text, or null to remove it.', $param, $key ) );
				}
				$current = 'term' === $kind ? get_term_meta( $id, $key, true ) : get_post_meta( $id, $key, true );
				if ( ! is_scalar( $current ) && '' !== $current ) {
					return self::invalid( sprintf( '%s.meta.%s holds structured data and cannot be changed with this tool.', $param, $key ) );
				}
				$ops['meta'][ $key ] = null === $new ? null : self::clean_text( (string) $new );
			}
			return $ops;
		}

		/** A JSON list (an empty array counts as one). */
		private static function is_list( $value ) {
			return is_array( $value ) && ( ! $value || array_keys( $value ) === range( 0, count( $value ) - 1 ) );
		}

		private static function is_id( $value ) {
			return ( is_int( $value ) && $value > 0 ) || ( is_string( $value ) && '' !== $value && ctype_digit( $value ) && (int) $value > 0 );
		}

		/** Check one value against its ACF field definition. Containers are checked row by row and sub field by sub field. */
		private static function check_value( $field, $value, $path ) {
			$type = (string) $field['type'];
			if ( ! in_array( $type, self::writable_types(), true ) ) {
				return self::invalid( sprintf( '%s is a %s field, which this tool cannot change.', $path, $type ) );
			}
			$containers = array( 'group', 'repeater', 'flexible_content' );
			if ( null === $value ) {
				return in_array( $type, $containers, true ) ? self::invalid( sprintf( '%s cannot be null; send an empty list or object instead.', $path ) ) : true;
			}
			$ok = true;
			switch ( $type ) {
				case 'text':
				case 'textarea':
				case 'wysiwyg':
				case 'oembed':
				case 'color_picker':
				case 'date_picker':
				case 'date_time_picker':
				case 'time_picker':
					$ok = is_string( $value ) ? true : 'text';
					break;
				case 'email':
					$ok = is_string( $value ) && ( '' === $value || is_email( $value ) ) ? true : 'an email address';
					break;
				case 'url':
					$ok = is_string( $value ) && ( '' === $value || preg_match( '#^https?://\S+$#i', $value ) ) ? true : 'an http or https URL';
					break;
				case 'number':
				case 'range':
					$ok = '' === $value || ( is_numeric( $value ) && ! is_bool( $value ) ) ? true : 'a number';
					break;
				case 'true_false':
					$ok = is_bool( $value ) || in_array( $value, array( 0, 1, '0', '1' ), true ) ? true : 'true or false';
					break;
				case 'image':
				case 'file':
					$ok = '' === $value || ( self::is_id( $value ) && 'attachment' === get_post_type( (int) $value ) ) ? true : 'the ID of an item in the media library';
					break;
				case 'gallery':
					$ok = self::is_list( $value ) || array() === $value ? true : 'a list of media library IDs';
					foreach ( true === $ok ? $value : array() as $item ) {
						if ( ! self::is_id( $item ) || 'attachment' !== get_post_type( (int) $item ) ) {
							$ok = 'a list of media library IDs';
						}
					}
					break;
				case 'post_object':
				case 'relationship':
				case 'taxonomy':
				case 'user':
				case 'page_link':
					$items = self::is_list( $value ) ? $value : array( $value );
					foreach ( $items as $item ) {
						if ( ! self::is_id( $item ) && ! ( 'page_link' === $type && is_string( $item ) && preg_match( '#^https?://\S+$#i', $item ) ) ) {
							$ok = 'an ID or a list of IDs';
						}
					}
					break;
				case 'select':
				case 'radio':
				case 'button_group':
				case 'checkbox':
					$multiple = 'checkbox' === $type || ( 'select' === $type && ! empty( $field['multiple'] ) );
					$items    = $multiple && is_array( $value ) ? $value : array( $value );
					if ( ! $multiple && is_array( $value ) ) {
						$ok = 'one choice';
						break;
					}
					$choices = ! empty( $field['choices'] ) && is_array( $field['choices'] ) ? array_map( 'strval', array_keys( $field['choices'] ) ) : array();
					$custom  = ! empty( $field['allow_custom'] ) || ! empty( $field['other_choice'] ) || ! empty( $field['create_options'] );
					foreach ( $items as $item ) {
						if ( ! is_scalar( $item ) || ( $choices && ! $custom && '' !== (string) $item && ! in_array( (string) $item, $choices, true ) ) ) {
							$ok = $choices ? 'one of: ' . implode( ', ', $choices ) : 'text';
						}
					}
					break;
				case 'link':
					$ok = '' === $value || ( is_array( $value ) && isset( $value['url'] ) && is_string( $value['url'] ) && ! array_diff( array_keys( $value ), array( 'url', 'title', 'target' ) ) ) ? true : 'a link {url, title, target}';
					break;
				case 'group':
					return is_array( $value ) && ( ! $value || ! self::is_list( $value ) ) ? self::check_row( self::sub_fields( $field ), $value, $path ) : self::invalid( sprintf( '%s must be an object of sub fields.', $path ) );
				case 'repeater':
					if ( ! self::is_list( $value ) && array() !== $value ) {
						return self::invalid( sprintf( '%s must be a list of rows.', $path ) );
					}
					if ( ! empty( $field['max'] ) && count( $value ) > (int) $field['max'] ) {
						return self::invalid( sprintf( '%s takes at most %d rows.', $path, (int) $field['max'] ) );
					}
					foreach ( $value as $i => $row ) {
						$checked = is_array( $row ) && ( ! $row || ! self::is_list( $row ) ) ? self::check_row( self::sub_fields( $field ), $row, $path . '[' . $i . ']' ) : self::invalid( sprintf( '%s[%d] must be an object of sub fields.', $path, $i ) );
						if ( is_wp_error( $checked ) ) {
							return $checked;
						}
					}
					return true;
				case 'flexible_content':
					if ( ! self::is_list( $value ) && array() !== $value ) {
						return self::invalid( sprintf( '%s must be a list of rows.', $path ) );
					}
					foreach ( $value as $i => $row ) {
						$layout = is_array( $row ) && isset( $row['acf_fc_layout'] ) && is_string( $row['acf_fc_layout'] ) ? $row['acf_fc_layout'] : '';
						$subs   = '' !== $layout ? self::sub_fields( $field, $layout ) : null;
						if ( null === $subs ) {
							return self::invalid( sprintf( '%s[%d] needs acf_fc_layout set to one of the layouts of this field.', $path, $i ) );
						}
						unset( $row['acf_fc_layout'] );
						$checked = self::check_row( $subs, $row, $path . '[' . $i . ']' );
						if ( is_wp_error( $checked ) ) {
							return $checked;
						}
					}
					return true;
			}
			return true === $ok ? true : self::invalid( sprintf( '%s must be %s.', $path, $ok ) );
		}

		/** Every key of a row or group must be one of its sub fields, and every value must fit that sub field. */
		private static function check_row( $subs, array $row, $path ) {
			$by_name = array();
			foreach ( (array) $subs as $sub ) {
				if ( is_array( $sub ) && ! empty( $sub['name'] ) ) {
					$by_name[ $sub['name'] ] = $sub;
				}
			}
			foreach ( $row as $name => $value ) {
				if ( ! isset( $by_name[ $name ] ) ) {
					return self::invalid( sprintf( '%s has no sub field "%s".', $path, $name ) );
				}
				$checked = self::check_value( $by_name[ $name ], $value, $path . '.' . $name );
				if ( is_wp_error( $checked ) ) {
					return $checked;
				}
			}
			return true;
		}

		/** A checked value in the form ACF stores: sub fields keyed by field key, text filtered. */
		private static function to_acf( $field, $value ) {
			$type = (string) $field['type'];
			if ( 'group' === $type ) {
				return self::row_to_acf( self::sub_fields( $field ), (array) $value );
			}
			if ( 'repeater' === $type ) {
				$rows = array();
				foreach ( (array) $value as $row ) {
					$rows[] = self::row_to_acf( self::sub_fields( $field ), (array) $row );
				}
				return $rows;
			}
			if ( 'flexible_content' === $type ) {
				$rows = array();
				foreach ( (array) $value as $row ) {
					$layout = $row['acf_fc_layout'];
					unset( $row['acf_fc_layout'] );
					$rows[] = array( 'acf_fc_layout' => $layout ) + self::row_to_acf( (array) self::sub_fields( $field, $layout ), $row );
				}
				return $rows;
			}
			return is_string( $value ) && in_array( $type, self::text_types(), true ) ? self::clean_text( $value ) : $value;
		}

		private static function row_to_acf( $subs, array $row ) {
			$out = array();
			foreach ( (array) $subs as $sub ) {
				if ( is_array( $sub ) && ! empty( $sub['name'] ) && array_key_exists( $sub['name'], $row ) ) {
					$out[ $sub['key'] ] = self::to_acf( $sub, $row[ $sub['name'] ] );
				}
			}
			return $out;
		}

		/** HTML is kept as sent for accounts allowed to post any HTML (Administrators, Editors); otherwise filtered like post content. */
		private static function clean_text( $text ) {
			return current_user_can( 'unfiltered_html' ) ? $text : wp_kses_post( $text );
		}

		/** REST write on posts, after WordPress saved the post. */
		public static function update_post_fields( $value, $post ) {
			$post_id = is_object( $post ) && isset( $post->ID ) ? (int) $post->ID : 0;
			return $post_id ? self::write( 'post', $post_id, '', $value ) : true;
		}

		/** REST write on terms. */
		public static function update_term_fields( $value, $term ) {
			$term_id  = is_object( $term ) && isset( $term->term_id ) ? (int) $term->term_id : 0;
			$taxonomy = is_object( $term ) && isset( $term->taxonomy ) ? (string) $term->taxonomy : '';
			return $term_id && '' !== $taxonomy ? self::write( 'term', $term_id, $taxonomy, $value ) : true;
		}

		/**
		 * Check everything first, then save. Nothing is saved unless every change passes.
		 *
		 * @return true|WP_Error
		 */
		private static function write( $kind, $id, $taxonomy, $value ) {
			$changes = self::sanitize_fields( $value );
			if ( null === $changes || ( ! $changes['fields'] && ! $changes['meta'] ) ) {
				return true;
			}
			if ( ! ( 'term' === $kind ? current_user_can( 'edit_term', $id ) : current_user_can( 'edit_post', $id ) ) ) {
				return new WP_Error( 'rest_cannot_edit', __( 'Sorry, you are not allowed to edit the custom fields of this item.', self::TEXT_DOMAIN ), array( 'status' => rest_authorization_required_code() ) );
			}
			try {
				$ops = self::plan( $kind, $id, $taxonomy, $changes, self::FIELDS );
				if ( is_wp_error( $ops ) ) {
					return $ops;
				}
				foreach ( $ops['fields'] as $op ) {
					update_field( $op[0]['key'], $op[1], $ops['acf_id'] ); // Returns false when the value is unchanged; that is fine.
				}
				foreach ( $ops['meta'] as $key => $text ) {
					if ( null === $text ) {
						'term' === $kind ? delete_term_meta( $id, $key ) : delete_post_meta( $id, $key );
					} else {
						'term' === $kind ? update_term_meta( $id, $key, wp_slash( $text ) ) : update_post_meta( $id, $key, wp_slash( $text ) );
					}
				}
			} catch ( \Throwable $e ) {
				return new WP_Error( 'mkt_fields_save_failed', __( 'The custom fields could not be saved.', self::TEXT_DOMAIN ), array( 'status' => 500 ) );
			}
			return true;
		}

		/** Tools > MKT SEO Bridge form: save the list of editable meta keys. */
		public static function save_meta_keys() {
			if ( ! current_user_can( 'manage_options' ) ) {
				wp_die( esc_html__( 'Sorry, you are not allowed to change these settings.', self::TEXT_DOMAIN ), 403 );
			}
			check_admin_referer( 'mkt_fields_meta_keys' );
			$raw  = isset( $_POST['mkt_fields_meta_keys'] ) && is_string( $_POST['mkt_fields_meta_keys'] ) ? wp_unslash( $_POST['mkt_fields_meta_keys'] ) : '';
			$keys = array_values( array_unique( array_filter( preg_split( '/[\s,]+/', $raw ), array( __CLASS__, 'meta_key_allowed' ) ) ) );
			update_option( self::META_KEYS_OPTION, $keys, false );
			wp_safe_redirect( admin_url( 'tools.php?page=mkt-seo-bridge&mkt-fields-saved=1' ) );
			exit;
		}

		/* ---------- Elementor layouts ("mkt_elementor") ---------- */

		const ELEMENTOR              = 'mkt_elementor';
		const ELEMENTOR_MIN          = '3.0.0';
		const ELEMENTOR_MAX_BYTES    = 5242880;
		const ELEMENTOR_MAX_ELEMENTS = 5000;
		const ELEMENTOR_MAX_DEPTH    = 30;

		/** Elementor 3.0 or later, checked without autoloading. */
		public static function elementor_active() {
			return defined( 'ELEMENTOR_VERSION' ) && version_compare( (string) ELEMENTOR_VERSION, self::ELEMENTOR_MIN, '>=' ) && class_exists( 'Elementor\Plugin', false );
		}

		/** Field schema. "source" and "version" tell the extension, via OPTIONS, whether layouts can be read and written here. */
		public static function elementor_schema() {
			return array(
				'description' => 'Elementor layout for MKT WP Publisher (SEO Bridge ' . self::VERSION . '). Read with ?mkt_elementor=1.',
				'type'        => array( 'object', 'null' ),
				'context'     => array( 'edit' ),
				'properties'  => array(
					'source'        => array(
						'type'     => 'string',
						'enum'     => array( self::elementor_active() ? 'elementor' : 'none' ),
						'readonly' => true,
					),
					'version'       => array(
						'type'     => 'string',
						'enum'     => array( self::VERSION ),
						'readonly' => true,
					),
					'elements'      => array( 'type' => 'array' ),
					'page_settings' => array( 'type' => 'object' ),
					'convert'       => array( 'type' => 'boolean' ),
				),
				'arg_options' => array(
					'validate_callback' => array( __CLASS__, 'validate_elementor' ),
					'sanitize_callback' => array( __CLASS__, 'sanitize_elementor' ),
				),
			);
		}

		/** REST read: the layout, only for requests that ask for it (?mkt_elementor=1, or a write containing it). Never throws. */
		public static function get_elementor( $object, $field_name = '', $request = null ) {
			try {
				$post_id = isset( $object['id'] ) ? (int) $object['id'] : 0;
				if ( ! $post_id || ! ( $request instanceof WP_REST_Request ) || ! $request->has_param( self::ELEMENTOR ) || ! current_user_can( 'edit_post', $post_id ) ) {
					return null;
				}
				return self::read_elementor( $post_id );
			} catch ( \Throwable $e ) {
				return null;
			}
		}

		/** The Elementor document of a post, or null. */
		private static function elementor_document( $post_id ) {
			if ( ! self::elementor_active() ) {
				return null;
			}
			$plugin = \Elementor\Plugin::$instance;
			if ( ! is_object( $plugin ) || empty( $plugin->documents ) || ! method_exists( $plugin->documents, 'get' ) ) {
				return null;
			}
			$document = $plugin->documents->get( $post_id, false );
			return is_object( $document ) ? $document : null;
		}

		/** Whether Elementor lets the current account edit this post (its post type is enabled, the role is allowed). */
		private static function elementor_editable( $post_id ) {
			$document = self::elementor_document( $post_id );
			if ( ! $document ) {
				return false;
			}
			return method_exists( $document, 'is_editable_by_current_user' ) ? (bool) $document->is_editable_by_current_user() : current_user_can( 'edit_post', $post_id );
		}

		/** Names of the widgets registered with Elementor (core, Pro and add-ons), or null when the list is not available. */
		public static function elementor_widget_types() {
			try {
				if ( ! self::elementor_active() ) {
					return null;
				}
				$plugin  = \Elementor\Plugin::$instance;
				$manager = is_object( $plugin ) && isset( $plugin->widgets_manager ) ? $plugin->widgets_manager : null;
				if ( ! is_object( $manager ) || ! method_exists( $manager, 'get_widget_types' ) ) {
					return null;
				}
				$types = $manager->get_widget_types();
				return is_array( $types ) && $types ? array_values( array_map( 'strval', array_keys( $types ) ) ) : null;
			} catch ( \Throwable $e ) {
				return null;
			}
		}

		/** The stored layout: Elementor keeps it as JSON text in _elementor_data (older versions as an array). */
		private static function stored_elements( $post_id, &$unreadable ) {
			$raw        = get_post_meta( $post_id, '_elementor_data', true );
			$unreadable = false;
			if ( is_array( $raw ) ) {
				return $raw;
			}
			if ( ! is_string( $raw ) || '' === $raw ) {
				return array();
			}
			$decoded = json_decode( $raw, true );
			if ( ! is_array( $decoded ) ) {
				$unreadable = true;
				return array();
			}
			return $decoded;
		}

		private static function read_elementor( $post_id ) {
			$unreadable = false;
			$elements   = self::stored_elements( $post_id, $unreadable );
			$settings   = get_post_meta( $post_id, '_elementor_page_settings', true );
			$out        = array(
				'source'               => self::elementor_active() ? 'elementor' : 'none',
				'version'              => self::VERSION,
				'elementor_version'    => defined( 'ELEMENTOR_VERSION' ) ? (string) ELEMENTOR_VERSION : '',
				'built_with_elementor' => 'builder' === get_post_meta( $post_id, '_elementor_edit_mode', true ),
				'editable'             => self::elementor_editable( $post_id ),
				'template'             => (string) get_post_meta( $post_id, '_wp_page_template', true ),
				'page_settings'        => is_array( $settings ) && $settings ? $settings : (object) array(),
				'elements'             => $elements,
				'widget_types'         => self::elementor_widget_types(),
				'locked_by'            => self::locked_by( $post_id ),
			);
			if ( $unreadable ) {
				$out['unreadable'] = true;
			}
			return $out;
		}

		/** REST argument validation: everything is checked before WordPress saves anything. */
		public static function validate_elementor( $value, $request = null, $param = self::ELEMENTOR ) {
			if ( null === $value ) {
				return true;
			}
			if ( ! is_array( $value ) ) {
				return self::invalid( sprintf( '%s must be an object.', $param ) );
			}
			try {
				$change = self::sanitize_elementor( $value );
				if ( ! isset( $change['elements'] ) && ! isset( $change['page_settings'] ) ) {
					return true; // Only read-only parts were sent back.
				}
				$id = $request instanceof WP_REST_Request ? (int) $request->get_param( 'id' ) : 0;
				if ( ! $id ) {
					return self::invalid( sprintf( '%s can only be written to an existing item.', $param ) );
				}
				$plan = self::plan_elementor( $id, $change, $param );
				return is_wp_error( $plan ) ? $plan : true;
			} catch ( \Throwable $e ) {
				return new WP_Error( 'mkt_elementor_check_failed', __( 'The Elementor layout could not be checked.', self::TEXT_DOMAIN ), array( 'status' => 500 ) );
			}
		}

		/** REST argument sanitising: the writable parts only; null stays null. Values are checked in plan_elementor(). */
		public static function sanitize_elementor( $value ) {
			if ( null === $value ) {
				return null;
			}
			$value = is_array( $value ) ? $value : array();
			$out   = array();
			foreach ( array( 'elements', 'page_settings' ) as $key ) {
				if ( array_key_exists( $key, $value ) && null !== $value[ $key ] ) {
					$out[ $key ] = $value[ $key ];
				}
			}
			if ( ! empty( $value['convert'] ) ) {
				$out['convert'] = true;
			}
			return $out;
		}

		/**
		 * Check a layout change and return what to save.
		 *
		 * @return array|WP_Error {elements?: list, page_settings?: array}
		 */
		private static function plan_elementor( $post_id, array $change, $param ) {
			if ( ! self::elementor_active() ) {
				/* translators: %s: minimum Elementor version */
				return self::invalid( sprintf( __( 'Elementor %s or later is not active on this site.', self::TEXT_DOMAIN ), self::ELEMENTOR_MIN ) );
			}
			if ( 'trash' === get_post_status( $post_id ) ) {
				return self::invalid( __( 'This item is in the trash. Restore it in WordPress first.', self::TEXT_DOMAIN ) );
			}
			$builder = self::get_builder( array( 'id' => $post_id ) );
			if ( $builder && 'elementor' !== $builder['id'] ) {
				/* translators: %s: page builder name */
				return self::invalid( sprintf( __( 'This item is built with %s, not Elementor. Nothing was saved.', self::TEXT_DOMAIN ), $builder['name'] ) );
			}
			$locked = self::locked_by( $post_id );
			if ( '' !== $locked ) {
				/* translators: %s: user name */
				return self::invalid( sprintf( __( '%s is editing this item in WordPress right now. Ask them to close the editor, then retry. Nothing was saved.', self::TEXT_DOMAIN ), $locked ) );
			}
			if ( ! self::elementor_editable( $post_id ) ) {
				return self::invalid( __( 'Elementor does not allow this account to edit this item. Check Elementor > Settings > General > Post Types (and the Role Manager). Nothing was saved.', self::TEXT_DOMAIN ) );
			}
			$filtered = ! current_user_can( 'unfiltered_html' );
			$ops      = array();
			if ( isset( $change['elements'] ) ) {
				if ( 'builder' !== get_post_meta( $post_id, '_elementor_edit_mode', true ) && empty( $change['convert'] ) ) {
					/* translators: %s: parameter name */
					return self::invalid( sprintf( __( '%s: this item is not built with Elementor yet. Send convert: true to switch it to Elementor; its current content is then replaced by the layout.', self::TEXT_DOMAIN ), $param ) );
				}
				$state    = array(
					'count'    => 0,
					'ids'      => array(),
					'widgets'  => self::elementor_widget_types(),
					'filtered' => $filtered,
				);
				$elements = self::check_elements( $change['elements'], null, 1, $state, $param . '.elements' );
				if ( is_wp_error( $elements ) ) {
					return $elements;
				}
				$json = wp_json_encode( $elements );
				if ( ! is_string( $json ) || strlen( $json ) > self::ELEMENTOR_MAX_BYTES ) {
					return self::invalid( sprintf( '%s.elements is larger than %d MB.', $param, self::ELEMENTOR_MAX_BYTES / 1048576 ) );
				}
				$ops['elements'] = $elements;
			}
			if ( isset( $change['page_settings'] ) ) {
				$settings = self::check_page_settings( $post_id, $change['page_settings'], $param . '.page_settings' );
				if ( is_wp_error( $settings ) ) {
					return $settings;
				}
				$ops['page_settings'] = $filtered ? self::filter_settings( $settings ) : $settings;
			}
			return $ops;
		}

		/** Which element types may sit directly inside which. null is the top level. */
		private static function child_allowed( $parent, $child ) {
			if ( 'widget' === $parent ) {
				return false;
			}
			if ( null === $parent ) {
				return ! in_array( $child, array( 'widget', 'column' ), true );
			}
			if ( 'section' === $parent ) {
				return 'column' === $child;
			}
			if ( 'column' === $parent ) {
				return in_array( $child, array( 'widget', 'section' ), true );
			}
			return ! in_array( $child, array( 'column', 'section' ), true ); // Containers and newer element types.
		}

		/**
		 * Check a list of elements recursively and return it cleaned: ids unique, element types nested the way Elementor
		 * allows, widgets registered on the site, isInner set as Elementor expects, text filtered for accounts without
		 * unfiltered_html. Keys the bridge does not know are kept as they are, so a layout read and written back stays intact.
		 */
		private static function check_elements( $elements, $parent, $depth, array &$state, $path, $in_inner = false ) {
			if ( ! self::is_list( $elements ) ) {
				return self::invalid( sprintf( '%s must be a list of elements.', $path ) );
			}
			if ( $depth > self::ELEMENTOR_MAX_DEPTH ) {
				return self::invalid( sprintf( '%s is nested more than %d levels deep.', $path, self::ELEMENTOR_MAX_DEPTH ) );
			}
			$clean = array();
			foreach ( $elements as $i => $element ) {
				$where = $path . '[' . $i . ']';
				if ( ! is_array( $element ) || ( $element && self::is_list( $element ) ) ) {
					return self::invalid( sprintf( '%s must be an element object.', $where ) );
				}
				if ( ++$state['count'] > self::ELEMENTOR_MAX_ELEMENTS ) {
					return self::invalid( sprintf( 'The layout has more than %d elements.', self::ELEMENTOR_MAX_ELEMENTS ) );
				}
				$id = isset( $element['id'] ) ? $element['id'] : null;
				if ( ! is_string( $id ) || ! preg_match( '/^[A-Za-z0-9_-]{1,40}$/', $id ) ) {
					return self::invalid( sprintf( '%s.id must be a short id of letters and digits, such as 3f2a9c1.', $where ) );
				}
				if ( isset( $state['ids'][ $id ] ) ) {
					return self::invalid( sprintf( '%s.id "%s" is used twice; every element needs its own id.', $where, $id ) );
				}
				$state['ids'][ $id ] = true;
				$type                = isset( $element['elType'] ) ? $element['elType'] : null;
				if ( ! is_string( $type ) || ! preg_match( '/^[a-z][a-z0-9_-]{0,60}$/', $type ) ) {
					return self::invalid( sprintf( '%s.elType must be section, column, container, widget or another Elementor element type.', $where ) );
				}
				if ( ! self::child_allowed( $parent, $type ) ) {
					return self::invalid( sprintf( '%s: a %s cannot be placed %s.', $where, $type, null === $parent ? 'at the top level' : 'inside a ' . $parent ) );
				}
				if ( 'section' === $type && $in_inner ) {
					return self::invalid( sprintf( '%s: Elementor allows inner sections only one level deep.', $where ) );
				}
				$settings = array_key_exists( 'settings', $element ) ? $element['settings'] : array();
				if ( ! is_array( $settings ) || ( $settings && self::is_list( $settings ) ) ) {
					return self::invalid( sprintf( '%s.settings must be an object.', $where ) );
				}
				if ( 'widget' === $type ) {
					$widget = isset( $element['widgetType'] ) ? $element['widgetType'] : null;
					if ( ! is_string( $widget ) || ! preg_match( '/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/', $widget ) ) {
						return self::invalid( sprintf( '%s.widgetType must name an Elementor widget, such as heading or text-editor.', $where ) );
					}
					if ( is_array( $state['widgets'] ) && ! in_array( $widget, $state['widgets'], true ) ) {
						return self::invalid( sprintf( '%s: the widget "%s" is not registered on this site; Elementor would drop it.', $where, $widget ) );
					}
					if ( $state['filtered'] && 'html' === $widget ) {
						return self::invalid( sprintf( '%s: this account may not post unfiltered HTML, so it cannot use the HTML widget.', $where ) );
					}
				}
				$children = array_key_exists( 'elements', $element ) ? $element['elements'] : array();
				if ( 'widget' === $type && ! empty( $children ) ) {
					return self::invalid( sprintf( '%s: a widget cannot contain other elements.', $where ) );
				}
				$element['settings'] = $state['filtered'] ? self::filter_settings( $settings ) : $settings;
				if ( in_array( $type, array( 'section', 'container' ), true ) ) {
					$element['isInner'] = null !== $parent;
				}
				$inner = $in_inner || ( 'section' === $type && null !== $parent );
				$kids  = self::check_elements( $children, $type, $depth + 1, $state, $where . '.elements', $inner );
				if ( is_wp_error( $kids ) ) {
					return $kids;
				}
				$element['elements'] = $kids;
				$clean[]             = $element;
			}
			return $clean;
		}

		/** Text in settings, filtered like post content (for accounts without unfiltered_html). */
		private static function filter_settings( $value ) {
			if ( is_string( $value ) ) {
				return wp_kses_post( $value );
			}
			if ( is_array( $value ) ) {
				foreach ( $value as $key => $item ) {
					$value[ $key ] = self::filter_settings( $item );
				}
			}
			return $value;
		}

		/**
		 * Page settings (the Elementor settings panel of the page). Post fields such as status and title are refused:
		 * they change through the extension's own tools, with their own confirmations.
		 *
		 * @return array|WP_Error
		 */
		private static function check_page_settings( $post_id, $settings, $path ) {
			if ( ! is_array( $settings ) || ( $settings && self::is_list( $settings ) ) ) {
				return self::invalid( sprintf( '%s must be an object.', $path ) );
			}
			foreach ( $settings as $key => $value ) {
				$key = (string) $key;
				if ( 0 === strpos( $key, 'post_' ) || in_array( $key, array( 'menu_order', 'comment_status', 'ping_status' ), true ) ) {
					return self::invalid( sprintf( '%s.%s cannot be changed here; the title, status, excerpt and featured image change through the post tools.', $path, $key ) );
				}
			}
			if ( array_key_exists( 'template', $settings ) ) {
				$allowed = array( '', 'default', 'elementor_canvas', 'elementor_header_footer', 'elementor_theme' );
				if ( function_exists( 'wp_get_theme' ) ) {
					$theme   = wp_get_theme();
					$allowed = array_merge( $allowed, array_map( 'strval', array_keys( (array) $theme->get_page_templates( null, (string) get_post_type( $post_id ) ) ) ) );
				}
				if ( ! is_string( $settings['template'] ) || ! in_array( $settings['template'], $allowed, true ) ) {
					return self::invalid( sprintf( '%s.template must be one of: %s.', $path, implode( ', ', array_filter( $allowed ) ) ) );
				}
			}
			return $settings;
		}

		/** REST write after WordPress saved the post: Elementor's own save, so its CSS, version and revisions are handled. */
		public static function update_elementor( $value, $post ) {
			$post_id = is_object( $post ) && isset( $post->ID ) ? (int) $post->ID : 0;
			if ( ! $post_id ) {
				return true;
			}
			$change = self::sanitize_elementor( $value );
			if ( null === $change || ( ! isset( $change['elements'] ) && ! isset( $change['page_settings'] ) ) ) {
				return true;
			}
			if ( ! current_user_can( 'edit_post', $post_id ) ) {
				return new WP_Error( 'rest_cannot_edit', __( 'Sorry, you are not allowed to edit the Elementor layout of this item.', self::TEXT_DOMAIN ), array( 'status' => rest_authorization_required_code() ) );
			}
			try {
				$ops = self::plan_elementor( $post_id, $change, self::ELEMENTOR );
				if ( is_wp_error( $ops ) ) {
					return $ops;
				}
				$document = self::elementor_document( $post_id );
				if ( ! $document || ! method_exists( $document, 'save' ) ) {
					return new WP_Error( 'mkt_elementor_save_failed', __( 'Elementor could not open this item.', self::TEXT_DOMAIN ), array( 'status' => 500 ) );
				}
				$data = array();
				if ( isset( $ops['elements'] ) ) {
					$data['elements'] = $ops['elements'];
				}
				if ( isset( $ops['page_settings'] ) ) {
					$data['settings'] = $ops['page_settings'];
				}
				if ( false === $document->save( $data ) ) {
					return new WP_Error( 'mkt_elementor_save_failed', __( 'Elementor did not save the layout.', self::TEXT_DOMAIN ), array( 'status' => 500 ) );
				}
				if ( isset( $ops['elements'] ) && method_exists( $document, 'set_is_built_with_elementor' ) ) {
					$document->set_is_built_with_elementor( true );
				}
			} catch ( \Throwable $e ) {
				return new WP_Error( 'mkt_elementor_save_failed', __( 'The Elementor layout could not be saved.', self::TEXT_DOMAIN ), array( 'status' => 500 ) );
			}
			return true;
		}

		/**
		 * The display name of another user who has this post open in an editor right now (WordPress's post lock), or
		 * ''. Same rule as wp_check_post_lock(), which is not loaded during REST requests.
		 */
		public static function locked_by( $post_id ) {
			$lock = get_post_meta( $post_id, '_edit_lock', true );
			if ( ! is_string( $lock ) || '' === $lock ) {
				return '';
			}
			$parts  = explode( ':', $lock );
			$time   = (int) $parts[0];
			$user   = isset( $parts[1] ) ? (int) $parts[1] : (int) get_post_meta( $post_id, '_edit_last', true );
			$window = (int) apply_filters( 'wp_check_post_lock_window', 150 );
			if ( ! $user || (int) get_current_user_id() === $user || $time <= time() - $window ) {
				return '';
			}
			$data = get_userdata( $user );
			return $data && ! empty( $data->display_name ) ? (string) $data->display_name : __( 'Another user', self::TEXT_DOMAIN );
		}

		/* ---------- Changes waiting in the block editor ("editor queue") ---------- */

		const REST_NS         = 'mkt-seo-bridge/v1';
		const QUEUE_META      = '_mkt_editor_queue';
		const QUEUE_MAX       = 20;
		const QUEUE_MAX_BYTES = 2097152;
		const QUEUE_KEEP_DAYS = 14;

		/** REST routes for the queue. Called from register(). */
		public static function register_queue_routes() {
			$id = '(?P<id>\d+)';
			register_rest_route(
				self::REST_NS,
				'/editor-queue/' . $id,
				array(
					array(
						'methods'             => 'GET',
						'callback'            => array( __CLASS__, 'queue_list' ),
						'permission_callback' => array( __CLASS__, 'queue_permission' ),
					),
					array(
						'methods'             => 'POST',
						'callback'            => array( __CLASS__, 'queue_add' ),
						'permission_callback' => array( __CLASS__, 'queue_permission' ),
					),
				)
			);
			register_rest_route(
				self::REST_NS,
				'/editor-queue/' . $id . '/(?P<item>[a-f0-9]{16})',
				array(
					'methods'             => 'POST',
					'callback'            => array( __CLASS__, 'queue_set_status' ),
					'permission_callback' => array( __CLASS__, 'queue_permission' ),
				)
			);
		}

		/** Only accounts that can edit the post, and only post types the bridge serves (no attachments, menus or templates). */
		public static function queue_permission( $request ) {
			$post_id = (int) $request->get_param( 'id' );
			$type    = $post_id ? get_post_type( $post_id ) : false;
			if ( ! $type || ! in_array( $type, self::post_types(), true ) ) {
				return new WP_Error( 'rest_post_invalid_id', __( 'Invalid post ID.', self::TEXT_DOMAIN ), array( 'status' => 404 ) );
			}
			if ( ! current_user_can( 'edit_post', $post_id ) ) {
				return new WP_Error( 'rest_cannot_edit', __( 'Sorry, you are not allowed to edit this item.', self::TEXT_DOMAIN ), array( 'status' => rest_authorization_required_code() ) );
			}
			return true;
		}

		/** Stored items, oldest first, without expired ones. */
		private static function queue_items( $post_id ) {
			$items = get_post_meta( $post_id, self::QUEUE_META, true );
			$keep  = time() - self::QUEUE_KEEP_DAYS * 86400;
			$out   = array();
			foreach ( is_array( $items ) ? $items : array() as $item ) {
				if ( is_array( $item ) && isset( $item['id'], $item['status'], $item['created'], $item['content'] ) && (int) $item['created'] >= $keep ) {
					$out[] = $item;
				}
			}
			return $out;
		}

		/** Save the list. When it is full, the oldest finished items go first; pending ones are never dropped here. */
		private static function queue_save( $post_id, array $items ) {
			while ( count( $items ) > self::QUEUE_MAX ) {
				$drop = null;
				foreach ( $items as $i => $item ) {
					if ( 'pending' !== $item['status'] ) {
						$drop = $i;
						break;
					}
				}
				if ( null === $drop ) {
					break;
				}
				array_splice( $items, $drop, 1 );
			}
			// update_post_meta() unslashes what it is given, which would remove the backslashes block markup uses in its
			// attributes (-…), so the list is slashed first. It returns false when nothing changed; that is a success too.
			return false !== update_post_meta( $post_id, self::QUEUE_META, wp_slash( $items ) ) || get_post_meta( $post_id, self::QUEUE_META, true ) === $items;
		}

		/** One item as the REST API returns it. */
		private static function queue_public( array $item, $with_content ) {
			$content = (string) $item['content'];
			$out     = array(
				'id'                => (string) $item['id'],
				'status'            => (string) $item['status'],
				'label'             => isset( $item['label'] ) ? (string) $item['label'] : '',
				'base_modified_gmt' => isset( $item['base_modified_gmt'] ) ? (string) $item['base_modified_gmt'] : '',
				'summary'           => isset( $item['summary'] ) && is_array( $item['summary'] ) ? $item['summary'] : array(),
				'created_gmt'       => gmdate( 'Y-m-d\TH:i:s', (int) $item['created'] ),
				'updated_gmt'       => gmdate( 'Y-m-d\TH:i:s', (int) ( isset( $item['updated'] ) ? $item['updated'] : $item['created'] ) ),
				'content_length'    => strlen( $content ),
				'content_sha256'    => hash( 'sha256', $content ),
			);
			if ( $with_content ) {
				$out['content'] = $content;
			}
			return $out;
		}

		public static function queue_list( $request ) {
			try {
				$post_id = (int) $request->get_param( 'id' );
				$with    = in_array( (string) $request->get_param( 'content' ), array( '1', 'true' ), true );
				$items   = array();
				foreach ( self::queue_items( $post_id ) as $item ) {
					$items[] = self::queue_public( $item, $with );
				}
				return array(
					'version' => self::VERSION,
					'post_id' => $post_id,
					'items'   => $items,
				);
			} catch ( \Throwable $e ) {
				return new WP_Error( 'mkt_queue_failed', __( 'The queued changes could not be read.', self::TEXT_DOMAIN ), array( 'status' => 500 ) );
			}
		}

		public static function queue_add( $request ) {
			try {
				$post_id = (int) $request->get_param( 'id' );
				$content = $request->get_param( 'content' );
				$base    = $request->get_param( 'base_modified_gmt' );
				$label   = $request->get_param( 'label' );
				$summary = $request->get_param( 'summary' );
				if ( ! is_string( $content ) || '' === trim( $content ) ) {
					return self::invalid( __( 'content must be the full new content of the item.', self::TEXT_DOMAIN ) );
				}
				if ( strlen( $content ) > self::QUEUE_MAX_BYTES ) {
					return self::invalid( __( 'content is larger than 2 MB.', self::TEXT_DOMAIN ) );
				}
				if ( ! is_string( $base ) || ! preg_match( '/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/', $base ) ) {
					return self::invalid( __( 'base_modified_gmt must be the modified_gmt the change was prepared from, such as 2026-10-20T10:00:00.', self::TEXT_DOMAIN ) );
				}
				$items   = self::queue_items( $post_id );
				$pending = 0;
				foreach ( $items as $item ) {
					$pending += 'pending' === $item['status'] ? 1 : 0;
				}
				if ( $pending >= self::QUEUE_MAX ) {
					/* translators: %d: number of changes */
					return self::invalid( sprintf( __( 'This item already has %d changes waiting in the editor. Apply or dismiss some first.', self::TEXT_DOMAIN ), $pending ) );
				}
				$lines = array();
				foreach ( is_array( $summary ) ? array_slice( $summary, 0, 50 ) : array() as $line ) {
					if ( is_array( $line ) ) {
						$lines[] = array(
							'before' => isset( $line['before'] ) && is_scalar( $line['before'] ) ? self::clip( (string) $line['before'], 300 ) : '',
							'after'  => isset( $line['after'] ) && is_scalar( $line['after'] ) ? self::clip( (string) $line['after'], 300 ) : '',
						);
					}
				}
				$item    = array(
					'id'                => bin2hex( random_bytes( 8 ) ),
					'status'            => 'pending',
					'label'             => self::clip( sanitize_text_field( is_string( $label ) ? $label : '' ), 200 ),
					'content'           => self::clean_text( $content ),
					'base_modified_gmt' => $base,
					'summary'           => $lines,
					'created'           => time(),
					'created_by'        => (int) get_current_user_id(),
				);
				$items[] = $item;
				if ( ! self::queue_save( $post_id, $items ) ) {
					return new WP_Error( 'mkt_queue_failed', __( 'The change could not be queued.', self::TEXT_DOMAIN ), array( 'status' => 500 ) );
				}
				return self::queue_public( $item, false );
			} catch ( \Throwable $e ) {
				return new WP_Error( 'mkt_queue_failed', __( 'The change could not be queued.', self::TEXT_DOMAIN ), array( 'status' => 500 ) );
			}
		}

		/** Mark one item applied (by the editor) or dismissed (by the editor or the extension). Finished items stay as they are. */
		public static function queue_set_status( $request ) {
			try {
				$post_id = (int) $request->get_param( 'id' );
				$id      = (string) $request->get_param( 'item' );
				$status  = $request->get_param( 'status' );
				if ( ! in_array( $status, array( 'applied', 'dismissed' ), true ) ) {
					return self::invalid( __( 'status must be applied or dismissed.', self::TEXT_DOMAIN ) );
				}
				$items = self::queue_items( $post_id );
				foreach ( $items as $i => $item ) {
					if ( (string) $item['id'] !== $id ) {
						continue;
					}
					if ( 'pending' === $item['status'] ) {
						$items[ $i ]['status']     = $status;
						$items[ $i ]['updated']    = time();
						$items[ $i ]['updated_by'] = (int) get_current_user_id();
						if ( ! self::queue_save( $post_id, $items ) ) {
							return new WP_Error( 'mkt_queue_failed', __( 'The change could not be updated.', self::TEXT_DOMAIN ), array( 'status' => 500 ) );
						}
					}
					return self::queue_public( $items[ $i ], false );
				}
				return new WP_Error( 'mkt_queue_not_found', __( 'There is no such queued change on this item (it may have expired).', self::TEXT_DOMAIN ), array( 'status' => 404 ) );
			} catch ( \Throwable $e ) {
				return new WP_Error( 'mkt_queue_failed', __( 'The change could not be updated.', self::TEXT_DOMAIN ), array( 'status' => 500 ) );
			}
		}

		private static function clip( $text, $max ) {
			return function_exists( 'mb_substr' ) ? mb_substr( $text, 0, $max ) : substr( $text, 0, $max );
		}

		/** The block editor script that shows queued changes with Apply and Dismiss buttons. Post editor only. */
		public static function enqueue_editor_queue() {
			try {
				$screen = function_exists( 'get_current_screen' ) ? get_current_screen() : null;
				if ( $screen && ( 'post' !== $screen->base || ! in_array( $screen->post_type, self::post_types(), true ) ) ) {
					return;
				}
				if ( ! current_user_can( 'edit_posts' ) ) {
					return;
				}
				wp_enqueue_script( 'mkt-editor-queue', plugins_url( 'assets/editor-queue.js', self::$file ), array( 'wp-api-fetch', 'wp-blocks', 'wp-data', 'wp-editor', 'wp-notices' ), self::VERSION, true );
				wp_add_inline_script(
					'mkt-editor-queue',
					'window.mktEditorQueue = ' . wp_json_encode(
						array(
							'route'    => '/' . self::REST_NS . '/editor-queue/',
							'interval' => 15000,
						)
					) . ';',
					'before'
				);
			} catch ( \Throwable $e ) {
				return; // Never break the editor.
			}
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
			$active   = self::active_seo_plugins();
			$plugin   = $keys
				/* translators: 1: active SEO plugins, 2: the one that is used */
				? $keys['name'] . ( count( $active ) > 1 ? ' ' . sprintf( __( '(%1$s are active; %2$s is used)', self::TEXT_DOMAIN ), implode( ', ', $active ), $keys['name'] ) : '' )
					. ( 'aioseo' === $keys['plugin'] ? ' ' . __( '(posts and pages; category and tag SEO is not supported for All in One SEO)', self::TEXT_DOMAIN ) : '' )
				: __( 'None found. Activate Yoast SEO, Rank Math, All in One SEO or SEOPress.', self::TEXT_DOMAIN );
			$rows     = array(
				array( __( 'Bridge version', self::TEXT_DOMAIN ), self::VERSION, true ),
				array( __( 'SEO plugin', self::TEXT_DOMAIN ), $plugin, (bool) $keys ),
				array( __( 'REST fields', self::TEXT_DOMAIN ), self::FIELD . ', ' . self::FIELDS . ', ' . self::BUILDER . ', ' . self::ELEMENTOR . ' ' . __( 'on posts, pages, products, other public post types and their categories and tags', self::TEXT_DOMAIN ), true ),
				array(
					__( 'Elementor layouts', self::TEXT_DOMAIN ),
					self::elementor_active()
						/* translators: %s: Elementor version */
						? sprintf( __( 'Elementor %s: layouts can be read and changed (saved through Elementor itself).', self::TEXT_DOMAIN ), (string) ELEMENTOR_VERSION )
						/* translators: %s: minimum Elementor version */
						: sprintf( __( 'Elementor %s or later is not active. Layouts cannot be changed.', self::TEXT_DOMAIN ), self::ELEMENTOR_MIN ),
					self::elementor_active(),
				),
				array( __( 'Editor queue', self::TEXT_DOMAIN ), __( 'On. Changes prepared by the extension appear in the block editor with Apply and Dismiss buttons.', self::TEXT_DOMAIN ), true ),
				array(
					__( 'Custom fields', self::TEXT_DOMAIN ),
					self::acf_active()
						? sprintf( __( 'Advanced Custom Fields %s', self::TEXT_DOMAIN ), defined( 'ACF_VERSION' ) ? ACF_VERSION : '' )
						: __( 'Advanced Custom Fields is not active. Only the meta keys listed below can be edited.', self::TEXT_DOMAIN ),
					self::acf_active(),
				),
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
				<p><?php esc_html_e( 'Lets WP Publisher (for Claude and for ChatGPT) read and update SEO titles, meta descriptions, focus keywords and canonical URLs, tells it which page builder owns a page so builder layouts are not overwritten, lets it change Elementor layouts through Elementor itself, and shows changes it prepares in the block editor for you to apply and save. There is nothing to configure here.', self::TEXT_DOMAIN ); ?></p>
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
							<td><?php echo $keys ? '<code>' . esc_html( ( isset( $keys['storage'] ) && 'aioseo' === $keys['storage'] ? 'aioseo_posts.' : '' ) . $keys[ $field ] ) . '</code>' : '&mdash;'; ?></td>
							<td><?php echo esc_html( number_format_i18n( $max ) ); ?></td>
						</tr>
					<?php endforeach; ?>
					</tbody>
				</table>
				<p class="description" style="margin-top:12px;"><?php esc_html_e( 'Only accounts that can edit a post can read or change its SEO fields. Values are saved as plain text (canonical URLs as http/https links); an empty value removes the field.', self::TEXT_DOMAIN ); ?></p>

				<h2><?php esc_html_e( 'Custom fields', self::TEXT_DOMAIN ); ?></h2>
				<p><?php esc_html_e( 'The extension can read and change the Advanced Custom Fields shown on a post, page, product or category, including rows inside repeaters and flexible content. Each value is checked against the field settings before it is saved. Only accounts that can edit the item can read or change its fields.', self::TEXT_DOMAIN ); ?></p>
				<?php if ( isset( $_GET['mkt-fields-saved'] ) ) : ?>
					<div class="notice notice-success inline"><p><?php esc_html_e( 'Editable meta keys saved.', self::TEXT_DOMAIN ); ?></p></div>
				<?php endif; ?>
				<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="max-width:820px;">
					<input type="hidden" name="action" value="mkt_fields_save_meta_keys" />
					<?php wp_nonce_field( 'mkt_fields_meta_keys' ); ?>
					<p><label for="mkt-fields-meta-keys"><strong><?php esc_html_e( 'Editable meta keys (optional)', self::TEXT_DOMAIN ); ?></strong></label></p>
					<p class="description"><?php esc_html_e( 'For custom fields that are not made with Advanced Custom Fields: list the post or term meta keys the extension may change, one per line. Only text values can be changed. Leave empty if you use Advanced Custom Fields only.', self::TEXT_DOMAIN ); ?></p>
					<textarea id="mkt-fields-meta-keys" name="mkt_fields_meta_keys" rows="5" class="large-text code"><?php echo esc_textarea( implode( "\n", array_filter( (array) get_option( self::META_KEYS_OPTION, array() ), 'is_string' ) ) ); ?></textarea>
					<?php submit_button( __( 'Save meta keys', self::TEXT_DOMAIN ) ); ?>
				</form>
			</div>
			<?php
		}
	}

	MKT_SEO_Bridge::boot( __FILE__ );
}
