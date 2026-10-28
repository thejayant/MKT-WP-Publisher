<?php
/**
 * Plugin Name:       MKT Publisher SEO Bridge for Yoast & Rank Math
 * Description:       Lets WP Publisher (for Claude and for ChatGPT) read and update the SEO title, meta description, focus keyword and canonical URL of posts and pages managed by Yoast SEO, Rank Math, All in One SEO or SEOPress, and their Advanced Custom Fields, through the WordPress REST API.
 * Version:           1.4.0
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

		const VERSION     = '1.4.0';
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
				array( __( 'REST fields', self::TEXT_DOMAIN ), self::FIELD . ', ' . self::FIELDS . ', ' . self::BUILDER . ' ' . __( 'on posts, pages, products, other public post types and their categories and tags', self::TEXT_DOMAIN ), true ),
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
				<p><?php esc_html_e( 'Lets WP Publisher (for Claude and for ChatGPT) read and update SEO titles, meta descriptions, focus keywords and canonical URLs, and tells it which page builder owns a page so builder layouts are not overwritten. There is nothing to configure here.', self::TEXT_DOMAIN ); ?></p>
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
