<?php
/**
 * Test harness for the SEO Bridge plugin: a minimal stand-in for WordPress, then one scenario per run.
 * Usage: php bridge-harness.php <scenario> <plugin-file>
 * Prints "OK <scenario>" on success; any PHP warning, notice or deprecation fails the run.
 *
 * The WordPress functions below are simplified stand-ins. They check that the plugin uses WordPress correctly
 * and never errors; they are not a substitute for a test on a real WordPress site.
 */

error_reporting( E_ALL );
set_error_handler(
	function ( $severity, $message, $file, $line ) {
		throw new ErrorException( $message, 0, $severity, $file, $line );
	}
);

$scenario = $argv[1] ?? '';
$plugin   = $argv[2] ?? '';

define( 'ABSPATH', __DIR__ . '/' );

// ---- WordPress stand-ins -------------------------------------------------------------------------------------
$GLOBALS['wp'] = array(
	'actions'  => array(),
	'filters'  => array(),
	'fields'   => array(),
	'meta'     => array(),
	'can_edit' => true,
	'admin'    => false,
	'types'    => array( 'post', 'page' ),
	'menu'     => array(),
);

class WP_Error {
	public $code;
	public $message;
	public $data;
	public function __construct( $code = '', $message = '', $data = '' ) {
		$this->code    = $code;
		$this->message = $message;
		$this->data    = $data;
	}
	public function get_error_code() {
		return $this->code;
	}
}

class WP_REST_Request {
	private $params;
	public function __construct( array $params ) {
		$this->params = $params;
	}
	public function has_param( $key ) {
		return array_key_exists( $key, $this->params );
	}
	public function get_param( $key ) {
		return $this->params[ $key ] ?? null;
	}
}

function is_wp_error( $thing ) {
	return $thing instanceof WP_Error;
}
function add_action( $hook, $callback, $priority = 10, $args = 1 ) {
	$GLOBALS['wp']['actions'][ $hook ][] = $callback;
	return true;
}
function add_filter( $hook, $callback, $priority = 10, $args = 1 ) {
	$GLOBALS['wp']['filters'][ $hook ][] = $callback;
	return true;
}
function do_action( $hook, ...$args ) {
	foreach ( $GLOBALS['wp']['actions'][ $hook ] ?? array() as $callback ) {
		call_user_func_array( $callback, $args );
	}
}
function apply_filters( $hook, $value, ...$args ) {
	foreach ( $GLOBALS['wp']['filters'][ $hook ] ?? array() as $callback ) {
		$value = call_user_func_array( $callback, array_merge( array( $value ), $args ) );
	}
	return $value;
}
function is_admin() {
	return $GLOBALS['wp']['admin'];
}
function plugin_basename( $file ) {
	return basename( dirname( $file ) ) . '/' . basename( $file );
}
function get_post_types( $args = array(), $output = 'names' ) {
	$all = array_merge( $GLOBALS['wp']['types'], array( 'attachment' ) );
	return array_combine( $all, $all );
}
function get_taxonomies( $args = array(), $output = 'names' ) {
	$GLOBALS['wp']['taxonomy_query'] = $args;
	$all = $GLOBALS['wp']['taxonomies'] ?? array( 'category', 'post_tag', 'nav_menu', 'post_format' );
	return array_combine( $all, $all );
}
function taxonomy_exists( $taxonomy ) {
	return in_array( $taxonomy, $GLOBALS['wp']['taxonomies'] ?? array( 'category', 'post_tag', 'nav_menu', 'post_format' ), true );
}
function get_term( $id ) {
	return $GLOBALS['wp']['terms'][ $id ] ?? null;
}
function get_term_meta( $id, $key, $single = false ) {
	if ( ! empty( $GLOBALS['wp']['meta_throws'] ) ) {
		throw new RuntimeException( 'database gone' );
	}
	return $GLOBALS['wp']['term_meta'][ $id ][ $key ] ?? '';
}
function update_term_meta( $id, $key, $value ) {
	$GLOBALS['wp']['term_meta'][ $id ][ $key ] = stripslashes( $value );
	return true;
}
function delete_term_meta( $id, $key ) {
	unset( $GLOBALS['wp']['term_meta'][ $id ][ $key ] );
	return true;
}
function get_option( $name, $default = false ) {
	return $GLOBALS['wp']['options'][ $name ] ?? $default;
}
function update_option( $name, $value ) {
	$GLOBALS['wp']['options'][ $name ] = $value;
	return true;
}
function post_type_exists( $type ) {
	return in_array( $type, $GLOBALS['wp']['types'], true );
}
function register_rest_field( $type, $name, $args ) {
	$GLOBALS['wp']['fields'][ $type ][ $name ] = $args;
}
function current_user_can( $cap, $id = 0 ) {
	if ( 'unfiltered_html' === $cap ) {
		return $GLOBALS['wp']['unfiltered_html'] ?? true;
	}
	return $GLOBALS['wp']['can_edit'];
}
function get_post_type( $id = null ) {
	return $GLOBALS['wp']['post_type_of'][ $id ] ?? 'post';
}
function wp_kses_post( $text ) {
	return preg_replace( '#<script\b[^>]*>.*?</script>#is', '', (string) $text );
}
function is_email( $email ) {
	return false !== filter_var( $email, FILTER_VALIDATE_EMAIL ) ? $email : false;
}
function wp_unslash( $value ) {
	return stripslashes( $value );
}
function wp_nonce_field( $action ) {
	echo '<input type="hidden" name="_wpnonce" value="nonce-' . htmlspecialchars( $action ) . '" />';
}
function check_admin_referer( $action ) {
	if ( ( $_POST['_wpnonce'] ?? '' ) !== 'nonce-' . $action ) {
		throw new RuntimeException( 'nonce check failed' );
	}
	return 1;
}
class Harness_Exit extends Exception {
}
function wp_safe_redirect( $location ) {
	throw new Harness_Exit( 'redirect ' . $location );
}
function wp_die( $message = '', $status = 500 ) {
	throw new Harness_Exit( 'die ' . $status );
}
function esc_textarea( $text ) {
	return htmlspecialchars( (string) $text, ENT_QUOTES );
}
function submit_button( $text = 'Save' ) {
	echo '<button>' . htmlspecialchars( $text ) . '</button>';
}
function get_post_meta( $id, $key, $single = false ) {
	if ( ! empty( $GLOBALS['wp']['meta_throws'] ) ) {
		throw new RuntimeException( 'database gone' );
	}
	return $GLOBALS['wp']['meta'][ $id ][ $key ] ?? '';
}
function update_post_meta( $id, $key, $value ) {
	if ( ! empty( $GLOBALS['wp']['meta_throws'] ) ) {
		throw new RuntimeException( 'database gone' );
	}
	$GLOBALS['wp']['meta'][ $id ][ $key ] = stripslashes( $value );
	return true;
}
function delete_post_meta( $id, $key ) {
	unset( $GLOBALS['wp']['meta'][ $id ][ $key ] );
	return true;
}
function wp_slash( $value ) {
	return addslashes( $value );
}
function sanitize_text_field( $text ) {
	return trim( preg_replace( '/[\r\n\t ]+/', ' ', strip_tags( (string) $text ) ) );
}
function esc_url_raw( $url, $protocols = null ) {
	return preg_match( '#^https?://\S+$#i', $url ) ? $url : '';
}
function rest_authorization_required_code() {
	return 401;
}
function rest_validate_value_from_schema( $value, $schema, $param = '' ) {
	if ( 'string' === $schema['type'] && ! is_string( $value ) ) {
		return new WP_Error( 'rest_invalid_type', "$param is not of type string." );
	}
	if ( isset( $schema['maxLength'] ) && ( function_exists( 'mb_strlen' ) ? mb_strlen( $value ) : strlen( $value ) ) > $schema['maxLength'] ) {
		return new WP_Error( 'rest_too_long', "$param must be at most {$schema['maxLength']} characters long." );
	}
	if ( isset( $schema['pattern'] ) && ! preg_match( '#' . $schema['pattern'] . '#u', $value ) ) {
		return new WP_Error( 'rest_invalid_pattern', "$param does not match pattern {$schema['pattern']}." );
	}
	return true;
}
function __( $text, $domain = 'default' ) {
	return $text;
}
function esc_html__( $text, $domain = 'default' ) {
	return htmlspecialchars( $text, ENT_QUOTES );
}
function esc_html_e( $text, $domain = 'default' ) {
	echo htmlspecialchars( $text, ENT_QUOTES );
}
function esc_html( $text ) {
	return htmlspecialchars( (string) $text, ENT_QUOTES );
}
function esc_url( $url ) {
	return htmlspecialchars( (string) $url, ENT_QUOTES );
}
function admin_url( $path = '' ) {
	return 'https://site.example/wp-admin/' . $path;
}
function plugins_url( $path, $file ) {
	return 'https://site.example/wp-content/plugins/' . basename( dirname( $file ) ) . '/' . $path;
}
function add_management_page( $page_title, $menu_title, $cap, $slug, $callback ) {
	$GLOBALS['wp']['menu'][ $slug ] = $callback;
	return 'tools_page_' . $slug;
}
function number_format_i18n( $n ) {
	return number_format( $n );
}
function wp_is_application_passwords_available() {
	return true;
}

// ---- helpers ------------------------------------------------------------------------------------------------
function check( $condition, $what ) {
	if ( ! $condition ) {
		fwrite( STDERR, "FAIL: $what\n" );
		exit( 1 );
	}
}
function field( $type = 'post' ) {
	return $GLOBALS['wp']['fields'][ $type ]['mkt_seo'];
}
function boot_rest() {
	do_action( 'rest_api_init' );
}
/** Simulate WordPress's update flow: validate + sanitize the argument, rest_pre_insert, save post, update_callback. */
function rest_update( $post_id, $raw, $type = 'post' ) {
	$args  = field( $type )['schema']['arg_options'];
	$valid = call_user_func( $args['validate_callback'], $raw, null, 'mkt_seo' );
	if ( is_wp_error( $valid ) ) {
		return $valid;
	}
	$clean   = call_user_func( $args['sanitize_callback'], $raw );
	$request = new WP_REST_Request( array( 'id' => $post_id, 'mkt_seo' => $clean ) );
	// WP_REST_Posts_Controller::prepare_item_for_database always sets post_type on the prepared post.
	$post    = apply_filters( "rest_pre_insert_{$type}", (object) array( 'ID' => $post_id, 'post_type' => $type ), $request );
	if ( is_wp_error( $post ) ) {
		return $post;
	}
	$GLOBALS['wp']['meta_at_save'] = $GLOBALS['wp']['meta'][ $post_id ] ?? array(); // What Yoast would see on save_post.
	if ( null !== $clean ) {
		return call_user_func( field( $type )['update_callback'], $clean, (object) array( 'ID' => $post_id ) );
	}
	return true;
}

/** Same flow for terms: WP_REST_Terms_Controller passes the request (with id) to rest_pre_insert_{taxonomy}. */
function rest_update_term( $term_id, $taxonomy, $raw ) {
	$args  = field( $taxonomy )['schema']['arg_options'];
	$valid = call_user_func( $args['validate_callback'], $raw, null, 'mkt_seo' );
	if ( is_wp_error( $valid ) ) {
		return $valid;
	}
	$clean   = call_user_func( $args['sanitize_callback'], $raw );
	$request = new WP_REST_Request( array( 'id' => $term_id, 'mkt_seo' => $clean, 'name' => 'Same name' ) );
	$term    = apply_filters( "rest_pre_insert_{$taxonomy}", (object) array( 'name' => 'Same name' ), $request );
	if ( is_wp_error( $term ) ) {
		return $term;
	}
	// What an SEO plugin would read during the edited_term action that wp_update_term fires next.
	$GLOBALS['wp']['seo_at_term_save'] = array( 'option' => $GLOBALS['wp']['options']['wpseo_taxonomy_meta'] ?? array(), 'meta' => $GLOBALS['wp']['term_meta'][ $term_id ] ?? array() );
	return call_user_func( field( $taxonomy )['update_callback'], $clean, (object) array( 'term_id' => $term_id, 'taxonomy' => $taxonomy ) );
}

/** WordPress's flow for an mkt_fields write: validate + sanitize the argument, save the post, then update_callback. */
function rest_update_fields( $id, $raw, $type = 'post' ) {
	$field = $GLOBALS['wp']['fields'][ $type ]['mkt_fields'];
	$args  = $field['schema']['arg_options'];
	$valid = call_user_func( $args['validate_callback'], $raw, new WP_REST_Request( array( 'id' => $id, 'mkt_fields' => $raw ) ), 'mkt_fields' );
	if ( is_wp_error( $valid ) ) {
		return $valid;
	}
	$clean  = call_user_func( $args['sanitize_callback'], $raw );
	$object = 'post' === $type || 'page' === $type || 'product' === $type ? (object) array( 'ID' => $id ) : (object) array( 'term_id' => $id, 'taxonomy' => $type );
	return call_user_func( $field['update_callback'], $clean, $object );
}

/** Read mkt_fields as the extension does (?mkt_fields=1), or as any other client does (no parameter). */
function read_fields( $id, $type = 'post', $ask = true ) {
	$object = 'post' === $type || 'page' === $type || 'product' === $type ? array( 'id' => $id ) : array( 'id' => $id, 'taxonomy' => $type );
	return call_user_func( $GLOBALS['wp']['fields'][ $type ]['mkt_fields']['get_callback'], $object, 'mkt_fields', new WP_REST_Request( $ask ? array( 'mkt_fields' => '1' ) : array() ) );
}

/**
 * A page field group like the client sites use: simple fields, a group, a repeater, Safeway-style flexible content
 * with a nested repeater, a read-only message field and a select. Values are stored keyed by field key, as ACF does.
 */
function load_acf_page_fixture() {
	require __DIR__ . '/acf-stubs.php';
	$GLOBALS['wp']['types']             = array( 'post', 'page' );
	$GLOBALS['wp']['post_type_of'][2549] = 'page';
	$GLOBALS['wp']['post_type_of'][77]   = 'attachment';
	$GLOBALS['wp']['post_type_of'][78]   = 'attachment';
	$GLOBALS['acf']['groups'][] = array(
		'match'  => function ( $screen ) {
			return 'page' === ( $screen['post_type'] ?? '' );
		},
		'fields' => array(
			array( 'key' => 'field_title', 'name' => 'hero_title', 'label' => 'Hero title', 'type' => 'text' ),
			array( 'key' => 'field_intro', 'name' => 'intro', 'label' => 'Intro', 'type' => 'wysiwyg' ),
			array( 'key' => 'field_img', 'name' => 'hero_image', 'label' => 'Hero image', 'type' => 'image' ),
			array( 'key' => 'field_note', 'name' => 'note', 'label' => 'Note', 'type' => 'message' ),
			array( 'key' => 'field_style', 'name' => 'style', 'label' => 'Style', 'type' => 'select', 'choices' => array( 'light' => 'Light', 'dark' => 'Dark' ) ),
			array(
				'key'        => 'field_cta',
				'name'       => 'cta',
				'label'      => 'Call to action',
				'type'       => 'group',
				'sub_fields' => array(
					array( 'key' => 'field_cta_label', 'name' => 'label', 'label' => 'Label', 'type' => 'text' ),
					array( 'key' => 'field_cta_link', 'name' => 'link', 'label' => 'Link', 'type' => 'url' ),
				),
			),
			array(
				'key'        => 'field_faqs',
				'name'       => 'faqs',
				'label'      => 'FAQs',
				'type'       => 'repeater',
				'max'        => 10,
				'sub_fields' => array(
					array( 'key' => 'field_q', 'name' => 'question', 'label' => 'Question', 'type' => 'text' ),
					array( 'key' => 'field_a', 'name' => 'answer', 'label' => 'Answer', 'type' => 'textarea' ),
				),
			),
			array(
				'key'     => 'field_fpc',
				'name'    => 'full_page_content',
				'label'   => 'Full page content',
				'type'    => 'flexible_content',
				'layouts' => array(
					'layout_abc' => array(
						'key'        => 'layout_abc',
						'name'       => '2_column_content',
						'label'      => '2 column content',
						'sub_fields' => array(
							array(
								'key'        => 'field_rows',
								'name'       => '2_column_content_row',
								'label'      => 'Rows',
								'type'       => 'repeater',
								'sub_fields' => array(
									array( 'key' => 'field_text', 'name' => '2_column_content_text', 'label' => 'Text', 'type' => 'wysiwyg' ),
									array( 'key' => 'field_image', 'name' => '2_column_content_image', 'label' => 'Image', 'type' => 'image' ),
								),
							),
						),
					),
				),
			),
		),
	);
	$GLOBALS['acf']['values'][2549] = array(
		'field_title' => 'Steel Buildings Virginia',
		'field_intro' => '<p>Old intro</p>',
		'field_img'   => '77',
		'field_style' => 'light',
		'field_cta'   => array( 'field_cta_label' => 'Call us', 'field_cta_link' => 'https://s.example/contact/' ),
		'field_faqs'  => array(
			array( 'field_q' => 'Q1', 'field_a' => 'A1' ),
			array( 'field_q' => 'Q2', 'field_a' => 'A2' ),
		),
		'field_fpc'   => array(
			array( 'acf_fc_layout' => '2_column_content', 'field_rows' => array( array( 'field_text' => '<p>Row 0</p>', 'field_image' => '77' ) ) ),
			array( 'acf_fc_layout' => '2_column_content', 'field_rows' => array( array( 'field_text' => '<p>Second section</p>', 'field_image' => '78' ) ) ),
			array( 'acf_fc_layout' => '2_column_content', 'field_rows' => array( array( 'field_text' => '<p>Row 2</p>', 'field_image' => '' ) ) ),
		),
	);
}

// ---- All in One SEO's table, as a minimal $wpdb ---------------------------------------------------------------
define( 'ARRAY_A', 'ARRAY_A' );
function wp_json_encode( $value ) {
	return json_encode( $value );
}
class Harness_WPDB {
	public $prefix = 'wp_';
	/** @var array<int,array> Rows of wp_aioseo_posts by post_id; null when the table does not exist. */
	public $aioseo = array();
	public $fail   = false;
	public function esc_like( $text ) {
		return addcslashes( $text, '_%\\' );
	}
	public function prepare( $query, ...$args ) {
		foreach ( $args as $arg ) {
			$query = preg_replace( '/%[ds]/', is_int( $arg ) ? (string) $arg : "'" . $arg . "'", $query, 1 );
		}
		return $query;
	}
	public function get_var( $query ) {
		return null === $this->aioseo ? null : 'wp_aioseo_posts';
	}
	public function get_row( $query, $output ) {
		preg_match( '/post_id = (\d+)/', $query, $m );
		return $this->aioseo[ (int) $m[1] ] ?? null;
	}
	public function update( $table, $data, $where ) {
		if ( $this->fail ) {
			return false;
		}
		$this->aioseo[ $where['post_id'] ] = array_merge( $this->aioseo[ $where['post_id'] ], $data );
		return 1;
	}
	public function insert( $table, $data ) {
		if ( $this->fail ) {
			return false;
		}
		$this->aioseo[ $data['post_id'] ] = $data + array( 'title' => null, 'description' => null, 'keyphrases' => null, 'canonical_url' => null );
		return 1;
	}
}
$GLOBALS['wpdb'] = new Harness_WPDB();

// ---- scenarios ----------------------------------------------------------------------------------------------
switch ( $scenario ) {
	case 'seopress':
		define( 'SEOPRESS_VERSION', '8.5' );
		require $plugin;
		boot_rest();
		check( array( 'seopress' ) === field()['schema']['properties']['plugin']['enum'], 'advertises seopress' );
		check( true === rest_update( 7, array( 'title' => 'SP <i>title</i>', 'description' => 'SP desc', 'focus_keyword' => 'carports', 'canonical' => 'https://a.example/sp' ) ), 'update ok' );
		check( 'SP title' === $GLOBALS['wp']['meta'][7]['_seopress_titles_title'], 'title saved to SEOPress meta' );
		check( 'SP desc' === $GLOBALS['wp']['meta'][7]['_seopress_titles_desc'], 'description saved' );
		check( 'carports' === $GLOBALS['wp']['meta'][7]['_seopress_analysis_target_kw'], 'focus keyword saved' );
		check( 'https://a.example/sp' === $GLOBALS['wp']['meta'][7]['_seopress_robots_canonical'], 'canonical saved' );
		$value = call_user_func( field()['get_callback'], array( 'id' => 7 ) );
		check( 'SP title' === $value['title'] && 'seopress' === $value['plugin'] && 'carports' === $value['focus_keyword'], 'read back' );
		rest_update( 7, array( 'description' => '' ) );
		check( ! isset( $GLOBALS['wp']['meta'][7]['_seopress_titles_desc'] ), 'empty string deletes' );
		// Terms use term meta with the same keys.
		check( array( 'seopress' ) === field( 'category' )['schema']['properties']['plugin']['enum'], 'terms advertise seopress' );
		break;

	case 'aioseo':
		define( 'AIOSEO_VERSION', '4.8.0' );
		require $plugin;
		boot_rest();
		check( array( 'aioseo' ) === field()['schema']['properties']['plugin']['enum'], 'advertises aioseo' );
		// Existing row with an additional keyphrase that must be kept.
		$GLOBALS['wpdb']->aioseo[7] = array( 'post_id' => 7, 'title' => 'Old', 'description' => 'Old desc', 'keyphrases' => '{"focus":{"keyphrase":"old","score":40,"analysis":{"x":1}},"additional":[{"keyphrase":"extra"}]}', 'canonical_url' => null );
		check( true === rest_update( 7, array( 'title' => 'AIO <b>title</b>', 'focus_keyword' => 'carports', 'canonical' => 'https://a.example/aio' ) ), 'update ok' );
		$row = $GLOBALS['wpdb']->aioseo[7];
		check( 'AIO title' === $row['title'] && 'Old desc' === $row['description'], 'title saved, description untouched' );
		check( 'https://a.example/aio' === $row['canonical_url'], 'canonical saved to canonical_url' );
		$phrases = json_decode( $row['keyphrases'], true );
		check( 'carports' === $phrases['focus']['keyphrase'] && 40 === $phrases['focus']['score'] && 'extra' === $phrases['additional'][0]['keyphrase'], 'focus keyphrase saved, rest of keyphrases kept' );
		check( ! empty( $row['updated'] ), 'updated time set' );
		check( empty( $GLOBALS['wp']['meta'][7] ), 'no post meta written' );
		$value = call_user_func( field()['get_callback'], array( 'id' => 7 ) );
		check( 'AIO title' === $value['title'] && 'carports' === $value['focus_keyword'] && 'aioseo' === $value['plugin'], 'read back' );
		rest_update( 7, array( 'description' => '' ) );
		check( null === $GLOBALS['wpdb']->aioseo[7]['description'], 'empty string stores NULL (AIOSEO default)' );
		// A post without a row gets one.
		$cb = field()['update_callback'];
		check( true === call_user_func( $cb, array( 'title' => 'Fresh', 'focus_keyword' => 'new' ), (object) array( 'ID' => 8 ) ), 'new post saved' );
		check( 'Fresh' === $GLOBALS['wpdb']->aioseo[8]['title'] && 8 === $GLOBALS['wpdb']->aioseo[8]['post_id'] && ! empty( $GLOBALS['wpdb']->aioseo[8]['created'] ), 'row created' );
		check( 'new' === json_decode( $GLOBALS['wpdb']->aioseo[8]['keyphrases'], true )['focus']['keyphrase'], 'keyphrase on new row' );
		// No row and no values: empty strings, never an error.
		$empty = call_user_func( field()['get_callback'], array( 'id' => 99 ) );
		check( '' === $empty['title'] && '' === $empty['focus_keyword'], 'missing row reads empty' );
		// Write failure is reported and stops the save.
		$GLOBALS['wpdb']->fail = true;
		check( is_wp_error( rest_update( 7, array( 'title' => 'X' ) ) ), 'database failure reported' );
		// Terms: All in One SEO term SEO is not written, so terms report no plugin.
		check( array( 'none' ) === field( 'category' )['schema']['properties']['plugin']['enum'], 'terms report none for aioseo' );
		break;

	case 'aioseo-missing-table':
		define( 'AIOSEO_VERSION', '4.8.0' );
		$GLOBALS['wpdb']->aioseo = null;
		require $plugin;
		boot_rest();
		$result = rest_update( 7, array( 'title' => 'X' ) );
		check( is_wp_error( $result ), 'missing table refused' );
		check( '' === call_user_func( field()['get_callback'], array( 'id' => 7 ) )['title'], 'missing table reads empty' );
		break;

	case 'seo-plugin-precedence':
		// Sites that already use Yoast or Rank Math keep using them when AIOSEO or SEOPress is also active.
		define( 'RANK_MATH_VERSION', '1.0.250' );
		define( 'AIOSEO_VERSION', '4.8.0' );
		define( 'SEOPRESS_VERSION', '8.5' );
		require $plugin;
		boot_rest();
		check( array( 'rank-math' ) === field()['schema']['properties']['plugin']['enum'], 'rank math wins over aioseo and seopress' );
		rest_update( 7, array( 'title' => 'RM' ) );
		check( 'RM' === $GLOBALS['wp']['meta'][7]['rank_math_title'] && empty( $GLOBALS['wpdb']->aioseo ), 'written to rank math only' );
		check( array( 'Rank Math', 'All in One SEO', 'SEOPress' ) === MKT_SEO_Bridge::active_seo_plugins(), 'all listed for the status page' );
		break;

	case 'page-builder':
		require $plugin;
		boot_rest();
		$builder = $GLOBALS['wp']['fields']['page']['mkt_builder'];
		check( true === $builder['schema']['readonly'] && ! isset( $builder['update_callback'] ), 'read-only field' );
		$get = $builder['get_callback'];
		$GLOBALS['wp']['meta'][10]['_elementor_edit_mode'] = 'builder';
		$GLOBALS['wp']['meta'][11]['_wpb_vc_js_status']    = 'true';
		$GLOBALS['wp']['meta'][12]['_fl_builder_enabled']  = '1';
		$GLOBALS['wp']['meta'][13]['_fl_builder_enabled']  = '0';
		$GLOBALS['wp']['meta'][14]['_elementor_edit_mode'] = '';
		check( array( 'id' => 'elementor', 'name' => 'Elementor', 'storage' => 'meta' ) === call_user_func( $get, array( 'id' => 10 ) ), 'elementor' );
		check( 'wpbakery' === call_user_func( $get, array( 'id' => 11 ) )['id'] && 'content' === call_user_func( $get, array( 'id' => 11 ) )['storage'], 'wpbakery stores layout in content' );
		check( 'beaver-builder' === call_user_func( $get, array( 'id' => 12 ) )['id'], 'beaver builder' );
		check( null === call_user_func( $get, array( 'id' => 13 ) ), 'beaver builder turned off' );
		check( null === call_user_func( $get, array( 'id' => 14 ) ), 'elementor meta present but not in builder mode' );
		check( null === call_user_func( $get, array( 'id' => 15 ) ), 'plain post' );
		$GLOBALS['wp']['can_edit'] = false;
		check( null === call_user_func( $get, array( 'id' => 10 ) ), 'hidden from users who cannot edit' );
		$GLOBALS['wp']['can_edit']    = true;
		$GLOBALS['wp']['meta_throws'] = true;
		check( null === call_user_func( $get, array( 'id' => 10 ) ), 'errors never break the response' );
		break;

	case 'all-post-types-and-taxonomies':
		$GLOBALS['wp']['types']      = array( 'post', 'page', 'product', 'locations' );
		$GLOBALS['wp']['taxonomies'] = array( 'category', 'post_tag', 'product_cat', 'product_tag', 'nav_menu', 'post_format', 'wp_pattern_category' );
		define( 'WPSEO_VERSION', '25.0' );
		require $plugin;
		boot_rest();
		check( isset( $GLOBALS['wp']['fields']['tag']['mkt_seo'] ) && ! isset( $GLOBALS['wp']['fields']['post_tag'] ), 'tags registered under "tag", the name the WordPress terms controller uses' );
		foreach ( array( 'post', 'page', 'product', 'locations', 'category', 'product_cat', 'product_tag' ) as $type ) {
			check( isset( $GLOBALS['wp']['fields'][ $type ]['mkt_seo'] ), "field on $type" );
			check( isset( $GLOBALS['wp']['fields'][ $type ]['mkt_fields'] ), "mkt_fields on $type" );
		}
		foreach ( array( 'attachment', 'nav_menu', 'post_format', 'wp_pattern_category' ) as $type ) {
			check( ! isset( $GLOBALS['wp']['fields'][ $type ] ), "no field on internal $type" );
		}
		check( array( '1.4.0' ) === field( 'product_cat' )['schema']['properties']['version']['enum'], 'term schema reports version' );
		check( array( 'show_ui' => true, 'show_in_rest' => true ) === $GLOBALS['wp']['taxonomy_query'], 'taxonomies chosen by show_ui + show_in_rest, not public (tags can be non-public)' );
		// A product update is saved early, like posts.
		check( true === rest_update( 9329, array( 'title' => 'Product SEO' ), 'product' ), 'product update ok' );
		check( 'Product SEO' === ( $GLOBALS['wp']['meta_at_save']['_yoast_wpseo_title'] ?? null ), 'product SEO saved before the product save' );
		break;

	case 'term-yoast':
		$GLOBALS['wp']['taxonomies'] = array( 'category', 'product_cat' );
		$GLOBALS['wp']['terms'][16]  = (object) array( 'term_id' => 16, 'taxonomy' => 'product_cat' );
		$GLOBALS['wp']['options']['wpseo_taxonomy_meta'] = array( 'product_cat' => array( 16 => array( 'wpseo_title' => 'Old', 'wpseo_noindex' => 'default' ) ), 'category' => array( 1 => array( 'wpseo_title' => 'Untouched' ) ) );
		define( 'WPSEO_VERSION', '25.0' );
		require $plugin;
		boot_rest();
		check( true === rest_update_term( 16, 'product_cat', array( 'title' => 'Carports <b>| AMB</b>', 'description' => 'Desc', 'canonical' => 'https://a.example/c/' ) ), 'term update ok' );
		$at_save = $GLOBALS['wp']['seo_at_term_save']['option']['product_cat'][16];
		check( 'Carports | AMB' === $at_save['wpseo_title'] && 'Desc' === $at_save['wpseo_desc'] && 'https://a.example/c/' === $at_save['wpseo_canonical'], 'saved into wpseo_taxonomy_meta before the term save, tags stripped' );
		check( 'default' === $at_save['wpseo_noindex'], 'other Yoast term settings kept' );
		check( 'Untouched' === $GLOBALS['wp']['options']['wpseo_taxonomy_meta']['category'][1]['wpseo_title'], 'other taxonomies untouched' );
		rest_update_term( 16, 'product_cat', array( 'description' => '' ) );
		check( ! isset( $GLOBALS['wp']['options']['wpseo_taxonomy_meta']['product_cat'][16]['wpseo_desc'] ), 'empty string removes' );
		$value = call_user_func( field( 'product_cat' )['get_callback'], array( 'id' => 16, 'taxonomy' => 'product_cat' ) );
		check( 'Carports | AMB' === $value['title'] && '' === $value['description'] && 'yoast' === $value['plugin'], 'term read back' );
		// A new term (no id yet) is saved by update_callback after it exists.
		$req = new WP_REST_Request( array( 'mkt_seo' => array( 'title' => 'New cat' ) ) );
		check( is_object( apply_filters( 'rest_pre_insert_product_cat', (object) array( 'name' => 'New' ), $req ) ), 'new term passes through' );
		call_user_func( field( 'product_cat' )['update_callback'], array( 'title' => 'New cat' ), (object) array( 'term_id' => 40, 'taxonomy' => 'product_cat' ) );
		check( 'New cat' === $GLOBALS['wp']['options']['wpseo_taxonomy_meta']['product_cat'][40]['wpseo_title'], 'new term saved' );
		check( is_wp_error( rest_update_term( 16, 'product_cat', array( 'title' => str_repeat( 'x', 301 ) ) ) ), 'too long rejected' );
		break;

	case 'term-rank-math':
		$GLOBALS['wp']['taxonomies'] = array( 'product_cat' );
		$GLOBALS['wp']['terms'][21]  = (object) array( 'term_id' => 21, 'taxonomy' => 'product_cat' );
		define( 'RANK_MATH_VERSION', '1.0.250' );
		require $plugin;
		boot_rest();
		check( true === rest_update_term( 21, 'product_cat', array( 'title' => 'Metal Garages', 'focus_keyword' => 'metal garages' ) ), 'term update ok' );
		check( 'Metal Garages' === ( $GLOBALS['wp']['seo_at_term_save']['meta']['rank_math_title'] ?? null ), 'saved to term meta before the term save' );
		check( 'metal garages' === $GLOBALS['wp']['term_meta'][21]['rank_math_focus_keyword'], 'focus keyword' );
		check( empty( $GLOBALS['wp']['options'] ), 'no Yoast option written' );
		break;

	case 'term-permissions-and-conflicts':
		$GLOBALS['wp']['taxonomies'] = array( 'product_cat', 'locations' );
		$GLOBALS['wp']['types']      = array( 'post', 'locations' );
		$GLOBALS['wp']['terms'][5]   = (object) array( 'term_id' => 5, 'taxonomy' => 'product_cat' );
		define( 'WPSEO_VERSION', '25.0' );
		require $plugin;
		boot_rest();
		// A post type and a taxonomy with the same name share the hook name; each callback only handles its own object.
		$post = (object) array( 'ID' => 7, 'post_type' => 'locations' );
		check( $post === MKT_SEO_Bridge::pre_insert_term( $post, new WP_REST_Request( array( 'id' => 7, 'mkt_seo' => array( 'title' => 'x' ) ) ) ), 'term callback ignores posts' );
		check( empty( $GLOBALS['wp']['options'] ), 'no term write for a post' );
		$error = new WP_Error( 'other', 'other plugin' );
		check( $error === MKT_SEO_Bridge::pre_insert_term( $error, new WP_REST_Request( array( 'id' => 5, 'mkt_seo' => array( 'title' => 'x' ) ) ) ), 'WP_Error passes through' );
		$GLOBALS['wp']['can_edit'] = false;
		check( null === call_user_func( field( 'product_cat' )['get_callback'], array( 'id' => 5, 'taxonomy' => 'product_cat' ) ), 'hidden without permission' );
		$denied = rest_update_term( 5, 'product_cat', array( 'title' => 'x' ) );
		check( is_wp_error( $denied ) && 'rest_cannot_edit' === $denied->get_error_code(), 'write refused without permission' );
		check( empty( $GLOBALS['wp']['options'] ), 'nothing written' );
		break;

	case 'loads-twice':
		// An old copy in another folder, or a must-use copy, plus the real one: no "Cannot redeclare" fatal.
		$copy = sys_get_temp_dir() . '/mkt-bridge-copy-' . getmypid() . '.php';
		copy( $plugin, $copy );
		require $plugin;
		require $copy;
		require_once $plugin;
		unlink( $copy );
		check( 1 === count( $GLOBALS['wp']['actions']['rest_api_init'] ), 'boots exactly once' );
		boot_rest();
		check( isset( $GLOBALS['wp']['fields']['post']['mkt_seo'], $GLOBALS['wp']['fields']['page']['mkt_seo'] ), 'field registered on post and page' );
		break;

	case 'no-seo-plugin':
		require $plugin;
		boot_rest();
		$schema = field()['schema'];
		check( array( 'none' ) === $schema['properties']['plugin']['enum'], 'advertises plugin none' );
		check( array( '1.4.0' ) === $schema['properties']['version']['enum'], 'advertises version' );
		$value = call_user_func( field()['get_callback'], array( 'id' => 5 ) );
		check( 'none' === $value['plugin'] && '' === $value['title'], 'get works without an SEO plugin' );
		check( true === rest_update( 5, array( 'title' => 'T' ) ), 'update is a harmless no-op' );
		check( empty( $GLOBALS['wp']['meta'] ), 'nothing written' );
		break;

	case 'yoast':
		define( 'WPSEO_VERSION', '25.0' );
		require $plugin;
		boot_rest();
		check( array( 'yoast' ) === field()['schema']['properties']['plugin']['enum'], 'advertises yoast' );
		// Existing post: values must already be stored when WordPress saves the post (Yoast rebuilds then).
		check( true === rest_update( 7, array( 'title' => 'New <b>title</b>', 'description' => 'Desc', 'canonical' => 'https://a.example/x' ) ), 'update ok' );
		check( 'New title' === ( $GLOBALS['wp']['meta_at_save']['_yoast_wpseo_title'] ?? null ), 'saved before the post save, tags stripped' );
		check( 'https://a.example/x' === $GLOBALS['wp']['meta'][7]['_yoast_wpseo_canonical'], 'canonical saved' );
		// Empty string deletes.
		rest_update( 7, array( 'description' => '' ) );
		check( ! isset( $GLOBALS['wp']['meta'][7]['_yoast_wpseo_metadesc'] ), 'empty string deletes' );
		// New post: no ID at pre_insert time; update_callback saves.
		$cb = field()['update_callback'];
		$req = new WP_REST_Request( array( 'mkt_seo' => array( 'title' => 'Fresh' ) ) );
		$out = apply_filters( 'rest_pre_insert_post', (object) array( 'post_title' => 'x' ), $req );
		check( is_object( $out ) && empty( $out->ID ), 'new post passes through pre_insert' );
		call_user_func( $cb, array( 'title' => 'Fresh' ), (object) array( 'ID' => 8 ) );
		check( 'Fresh' === $GLOBALS['wp']['meta'][8]['_yoast_wpseo_title'], 'new post saved by update_callback' );
		$value = call_user_func( field()['get_callback'], array( 'id' => 7 ) );
		check( 'New title' === $value['title'] && 'yoast' === $value['plugin'] && '1.4.0' === $value['version'], 'read back' );
		break;

	case 'rank-math-with-hostile-autoloader':
		// A third-party autoloader that throws for unknown classes must never be triggered by the bridge.
		spl_autoload_register(
			function ( $class ) {
				throw new LogicException( 'autoloader was called for ' . $class );
			}
		);
		define( 'RANK_MATH_VERSION', '1.0.250' );
		require $plugin;
		boot_rest();
		check( array( 'rank-math' ) === field()['schema']['properties']['plugin']['enum'], 'advertises rank-math' );
		rest_update( 9, array( 'focus_keyword' => 'kw', 'canonical' => 'https://b.example/' ) );
		check( 'kw' === $GLOBALS['wp']['meta'][9]['rank_math_focus_keyword'] && 'https://b.example/' === $GLOBALS['wp']['meta'][9]['rank_math_canonical_url'], 'rank math keys' );
		break;

	case 'both-plugins':
		define( 'WPSEO_VERSION', '25.0' );
		define( 'RANK_MATH_VERSION', '1.0.250' );
		require $plugin;
		boot_rest();
		check( array( 'yoast' ) === field()['schema']['properties']['plugin']['enum'], 'yoast wins' );
		check( MKT_SEO_Bridge::both_active(), 'both detected' );
		break;

	case 'lenient-input':
		define( 'WPSEO_VERSION', '25.0' );
		require $plugin;
		boot_rest();
		$args = field()['schema']['arg_options'];
		// A client that sends back the whole object it read, with stale read-only parts, must not be rejected.
		check( true === call_user_func( $args['validate_callback'], array( 'plugin' => 'rank-math', 'version' => '0.9', 'title' => 'T' ), null, 'mkt_seo' ), 'stale read-only parts ignored' );
		check( true === call_user_func( $args['validate_callback'], null, null, 'mkt_seo' ), 'null accepted' );
		check( array( 'title' => 'T' ) === call_user_func( $args['sanitize_callback'], array( 'plugin' => 'x', 'version' => 'y', 'title' => 'T', 'extra' => 'z' ) ), 'only editable fields kept' );
		check( null === call_user_func( $args['sanitize_callback'], null ), 'null stays null' );
		check( true === rest_update( 3, null ), 'null update writes nothing and succeeds' );
		check( empty( $GLOBALS['wp']['meta'][3] ), 'nothing written for null' );
		// Real problems are still rejected before anything is saved.
		check( is_wp_error( call_user_func( $args['validate_callback'], 'text', null, 'mkt_seo' ) ), 'non-object rejected' );
		check( is_wp_error( rest_update( 3, array( 'title' => str_repeat( 'x', 301 ) ) ) ), 'too long rejected' );
		check( is_wp_error( rest_update( 3, array( 'canonical' => 'javascript:alert(1)' ) ) ), 'bad canonical rejected' );
		check( is_wp_error( rest_update( 3, array( 'canonical' => 'https://a b' ) ) ), 'canonical with space rejected' );
		check( empty( $GLOBALS['wp']['meta'][3] ), 'nothing written for rejected values' );
		check( true === rest_update( 3, array( 'canonical' => '' ) ), 'empty canonical accepted' );
		break;

	case 'other-plugins-filters':
		define( 'WPSEO_VERSION', '25.0' );
		require $plugin;
		boot_rest();
		$error = new WP_Error( 'other_plugin', 'blocked by another plugin' );
		check( $error === MKT_SEO_Bridge::pre_insert( $error, new WP_REST_Request( array( 'mkt_seo' => array( 'title' => 'T' ) ) ) ), 'WP_Error from another plugin passes through' );
		$post = (object) array( 'ID' => 4 );
		check( $post === MKT_SEO_Bridge::pre_insert( $post, new WP_REST_Request( array( 'title' => 'only core fields' ) ) ), 'requests without mkt_seo untouched' );
		check( $post === MKT_SEO_Bridge::pre_insert( $post, null ), 'odd request argument tolerated' );
		check( empty( $GLOBALS['wp']['meta'] ), 'nothing written for other requests' );
		check( array( 'a' ) !== MKT_SEO_Bridge::action_links( 'not-an-array' ) || true, 'action links tolerate odd input' );
		break;

	case 'no-permission':
		define( 'WPSEO_VERSION', '25.0' );
		require $plugin;
		boot_rest();
		$GLOBALS['wp']['can_edit'] = false;
		check( null === call_user_func( field()['get_callback'], array( 'id' => 2 ) ), 'hidden from users who cannot edit' );
		$result = rest_update( 2, array( 'title' => 'T' ) );
		check( is_wp_error( $result ) && 'rest_cannot_edit' === $result->get_error_code(), 'write refused' );
		check( empty( $GLOBALS['wp']['meta'] ), 'nothing written' );
		break;

	case 'storage-failure':
		define( 'WPSEO_VERSION', '25.0' );
		require $plugin;
		boot_rest();
		$GLOBALS['wp']['meta_throws'] = true;
		check( null === call_user_func( field()['get_callback'], array( 'id' => 2 ) ), 'read failure gives null, no fatal' );
		$result = rest_update( 2, array( 'title' => 'T' ) );
		check( is_wp_error( $result ) && 'mkt_seo_save_failed' === $result->get_error_code(), 'write failure gives WP_Error, no fatal' );
		break;

	case 'custom-site-without-pages':
		$GLOBALS['wp']['types'] = array( 'post' ); // A custom site that unregistered pages.
		define( 'WPSEO_VERSION', '25.0' );
		require $plugin;
		boot_rest();
		check( isset( $GLOBALS['wp']['fields']['post']['mkt_seo'] ) && ! isset( $GLOBALS['wp']['fields']['page'] ), 'skips missing post types' );
		break;

	case 'admin-page':
		$GLOBALS['wp']['admin'] = true;
		define( 'WPSEO_VERSION', '25.0' );
		define( 'RANK_MATH_VERSION', '1.0.250' );
		require $plugin;
		do_action( 'admin_menu' );
		check( isset( $GLOBALS['wp']['menu']['mkt-seo-bridge'] ), 'status page registered' );
		$links = apply_filters( 'plugin_action_links_' . plugin_basename( $plugin ), array( '<a>Deactivate</a>' ) );
		check( 2 === count( $links ) && false !== strpos( $links[0], 'tools.php?page=mkt-seo-bridge' ), 'Status link added first' );
		ob_start();
		call_user_func( $GLOBALS['wp']['menu']['mkt-seo-bridge'] );
		$html = ob_get_clean();
		check( false !== strpos( $html, 'MKT Publisher SEO Bridge' ) && false !== strpos( $html, 'icon-128x128.png' ), 'page renders with icon' );
		check( false !== strpos( $html, 'Yoast SEO is used' ) && false !== strpos( $html, '_yoast_wpseo_canonical' ), 'page shows plugin and fields' );
		$GLOBALS['wp']['can_edit'] = false;
		break;

	case 'fields-acf-read':
		load_acf_page_fixture();
		define( 'WPSEO_VERSION', '25.0' );
		require $plugin;
		boot_rest();
		$schema = $GLOBALS['wp']['fields']['page']['mkt_fields']['schema'];
		check( array( 'acf' ) === $schema['properties']['source']['enum'] && array( '1.4.0' ) === $schema['properties']['version']['enum'], 'schema advertises ACF and the bridge version' );
		check( null === read_fields( 2549, 'page', false ), 'not computed for requests that do not ask for it (editor, other clients)' );
		$f      = read_fields( 2549, 'page' );
		$screen = end( $GLOBALS['acf']['screens'] );
		check( 'acf' === $f['source'] && '6.3.5' === $f['acf_version'] && '1.4.0' === $f['version'], 'source and versions' );
		check( 2549 === $screen['post_id'] && 'page' === $screen['post_type'], "ACF's location rules get the post and its type" );
		$fields = $f['fields'];
		check( 'Steel Buildings Virginia' === $fields['hero_title']['value'] && 'text' === $fields['hero_title']['type'] && true === $fields['hero_title']['writable'], 'simple field' );
		check( false === $fields['note']['writable'], 'message field is read-only' );
		check( array( 'light', 'dark' ) === $fields['style']['choices'], 'choices listed' );
		check( array( 'label' => 'Call us', 'link' => 'https://s.example/contact/' ) === $fields['cta']['value'], 'group keyed by sub field name' );
		check( array( array( 'question' => 'Q1', 'answer' => 'A1' ), array( 'question' => 'Q2', 'answer' => 'A2' ) ) === $fields['faqs']['value'] && 10 === $fields['faqs']['max'], 'repeater rows by name, with max' );
		check( '<p>Second section</p>' === $fields['full_page_content']['value'][1]['2_column_content_row'][0]['2_column_content_text'], 'flexible content with a nested repeater, by name' );
		check( '2_column_content' === $fields['full_page_content']['value'][1]['acf_fc_layout'], 'layout name kept' );
		check( 'wysiwyg' === $fields['full_page_content']['layouts']['2_column_content']['sub_fields']['2_column_content_row']['sub_fields']['2_column_content_text']['type'], 'nested definitions' );
		check( array() === $f['meta'], 'no meta keys listed' );
		$GLOBALS['wp']['can_edit'] = false;
		check( null === read_fields( 2549, 'page' ), 'hidden from users who cannot edit' );
		break;

	case 'fields-acf-write':
		load_acf_page_fixture();
		require $plugin;
		boot_rest();
		$before                                                      = read_fields( 2549, 'page' )['fields'];
		$fpc                                                         = $before['full_page_content']['value'];
		$fpc[1]['2_column_content_row'][0]['2_column_content_text'] = '<p>New second section</p>';
		$faqs                                                        = $before['faqs']['value'];
		$faqs[1]['answer']                                           = 'New A2';
		check( true === rest_update_fields( 2549, array( 'fields' => array( 'full_page_content' => $fpc, 'faqs' => $faqs, 'hero_title' => 'New title' ), 'source' => 'acf', 'version' => '1.0' ), 'page' ), 'write ok (read-only parts sent back are ignored)' );
		$stored = $GLOBALS['acf']['values'][2549];
		check( '<p>New second section</p>' === $stored['field_fpc'][1]['field_rows'][0]['field_text'], 'nested text saved under field keys' );
		check( '<p>Row 0</p>' === $stored['field_fpc'][0]['field_rows'][0]['field_text'] && '78' === $stored['field_fpc'][1]['field_rows'][0]['field_image'], 'other rows and images kept' );
		check( '2_column_content' === $stored['field_fpc'][2]['acf_fc_layout'], 'layouts kept' );
		check( 'New A2' === $stored['field_faqs'][1]['field_a'] && 'Q1' === $stored['field_faqs'][0]['field_q'], 'repeater row changed, others kept' );
		check( 'field_fpc' === $GLOBALS['acf']['writes'][0][0] && 2549 === $GLOBALS['acf']['writes'][0][2], 'update_field by field key on the post' );
		check( '<p>New second section</p>' === read_fields( 2549, 'page' )['fields']['full_page_content']['value'][1]['2_column_content_row'][0]['2_column_content_text'], 'read back by name' );
		// HTML from accounts without unfiltered_html is filtered like post content.
		$GLOBALS['wp']['unfiltered_html'] = false;
		rest_update_fields( 2549, array( 'fields' => array( 'intro' => '<p>Hi</p><script>alert(1)</script>' ) ), 'page' );
		check( '<p>Hi</p>' === $GLOBALS['acf']['values'][2549]['field_intro'], 'script removed for accounts without unfiltered_html' );
		$GLOBALS['wp']['unfiltered_html'] = true;
		// Refused before anything is saved.
		$writes = count( $GLOBALS['acf']['writes'] );
		$cases  = array(
			array( array( 'nope' => 'x' ), 'no custom field "nope"' ),
			array( array( 'note' => 'x' ), 'message field' ),
			array( array( 'hero_title' => array( 'x' ) ), 'must be text' ),
			array( array( 'hero_image' => '999' ), 'media library' ),
			array( array( 'style' => 'neon' ), 'one of: light, dark' ),
			array( array( 'cta' => array( 'label' => 'x', 'colour' => 'red' ) ), 'no sub field "colour"' ),
			array( array( 'cta' => array( 'link' => 'javascript:alert(1)' ) ), 'http or https URL' ),
			array( array( 'faqs' => 'x' ), 'list of rows' ),
			array( array( 'faqs' => array_fill( 0, 11, array( 'question' => 'q' ) ) ), 'at most 10 rows' ),
			array( array( 'full_page_content' => array( array( 'acf_fc_layout' => 'hero' ) ) ), 'acf_fc_layout' ),
			array( array( 'full_page_content' => array( array( 'acf_fc_layout' => '2_column_content', '2_column_content_row' => array( array( '2_column_content_image' => 'abc' ) ) ) ) ), 'full_page_content[0].2_column_content_row[0].2_column_content_image' ),
			array( array( 'faqs' => null ), 'cannot be null' ),
			array( array( 'hero_title' => 'ok', 'hero_image' => 'bad' ), 'media library' ),
		);
		foreach ( $cases as $case ) {
			$result = rest_update_fields( 2549, array( 'fields' => $case[0] ), 'page' );
			check( is_wp_error( $result ) && false !== strpos( $result->message, $case[1] ), 'refused: ' . $case[1] . ' (got ' . ( is_wp_error( $result ) ? $result->message : 'success' ) . ')' );
		}
		check( count( $GLOBALS['acf']['writes'] ) === $writes, 'nothing saved for refused changes' );
		check( 'New title' === $GLOBALS['acf']['values'][2549]['field_title'], 'a refused request saves none of its changes' );
		// null clears a simple field; an empty repeater is allowed.
		check( true === rest_update_fields( 2549, array( 'fields' => array( 'hero_image' => null, 'faqs' => array() ) ), 'page' ), 'clearing ok' );
		check( null === $GLOBALS['acf']['values'][2549]['field_img'] && array() === $GLOBALS['acf']['values'][2549]['field_faqs'], 'cleared' );
		// New items, and accounts that cannot edit, are refused.
		$validate = $GLOBALS['wp']['fields']['page']['mkt_fields']['schema']['arg_options']['validate_callback'];
		check( is_wp_error( call_user_func( $validate, array( 'fields' => array( 'hero_title' => 'x' ) ), new WP_REST_Request( array() ), 'mkt_fields' ) ), 'new items refused' );
		check( is_wp_error( call_user_func( $validate, array( 'fields' => 'x' ), new WP_REST_Request( array( 'id' => 2549 ) ), 'mkt_fields' ) ), 'fields must be an object' );
		$GLOBALS['wp']['can_edit'] = false;
		$denied                    = call_user_func( $GLOBALS['wp']['fields']['page']['mkt_fields']['update_callback'], array( 'fields' => array( 'hero_title' => 'x' ), 'meta' => array() ), (object) array( 'ID' => 2549 ) );
		check( is_wp_error( $denied ) && 'rest_cannot_edit' === $denied->get_error_code(), 'write refused without permission' );
		break;

	case 'fields-meta':
		$GLOBALS['wp']['taxonomies']                     = array( 'category', 'locations_region' );
		$GLOBALS['wp']['terms'][9]                       = (object) array( 'term_id' => 9, 'taxonomy' => 'locations_region' );
		$GLOBALS['wp']['options']['mkt_fields_meta_keys'] = array( 'city_intro', '_wp_page_template', 'bad key', 'state_faq', 3 );
		$GLOBALS['wp']['meta'][590]                      = array( 'city_intro' => 'Old intro', 'state_faq' => array( 'q' => 'structured' ) );
		require $plugin;
		add_filter(
			'mkt_fields_meta_keys',
			function ( $keys, $kind ) {
				$keys[] = 'region_note';
				return $keys;
			}
		);
		boot_rest();
		check( array( 'city_intro', 'state_faq', 'region_note' ) === MKT_SEO_Bridge::meta_keys( 'post' ), 'internal and malformed keys dropped; the filter adds keys' );
		$f = read_fields( 590 );
		check( 'none' === $f['source'] && array() === $f['fields'], 'no ACF: no fields' );
		check( array( 'value' => 'Old intro', 'writable' => true ) === $f['meta']['city_intro'], 'listed meta read' );
		check( false === $f['meta']['state_faq']['writable'], 'structured meta is read-only' );
		check( true === rest_update_fields( 590, array( 'meta' => array( 'city_intro' => 'New <b>intro</b>' ) ) ), 'meta write ok' );
		check( 'New <b>intro</b>' === $GLOBALS['wp']['meta'][590]['city_intro'], 'meta saved' );
		$refused = rest_update_fields( 590, array( 'meta' => array( '_wp_page_template' => 'x' ) ) );
		check( is_wp_error( $refused ) && false !== strpos( $refused->message, 'not in the list' ), 'internal key refused even when listed' );
		check( is_wp_error( rest_update_fields( 590, array( 'meta' => array( 'state_faq' => 'x' ) ) ) ), 'structured value not overwritten' );
		check( is_wp_error( rest_update_fields( 590, array( 'meta' => array( 'city_intro' => array( 'x' ) ) ) ) ), 'non-text refused' );
		$no_acf = rest_update_fields( 590, array( 'fields' => array( 'hero_title' => 'x' ) ) );
		check( is_wp_error( $no_acf ) && false !== strpos( $no_acf->message, 'Advanced Custom Fields is not active' ), 'ACF fields refused without ACF' );
		check( true === rest_update_fields( 590, array( 'meta' => array( 'city_intro' => null ) ) ) && ! isset( $GLOBALS['wp']['meta'][590]['city_intro'] ), 'null removes the value' );
		check( true === rest_update_fields( 9, array( 'meta' => array( 'region_note' => 'East' ) ), 'locations_region' ), 'term meta write' );
		check( 'East' === $GLOBALS['wp']['term_meta'][9]['region_note'] && 'East' === read_fields( 9, 'locations_region' )['meta']['region_note']['value'], 'term meta saved and read' );
		break;

	case 'fields-terms':
		require __DIR__ . '/acf-stubs.php';
		$GLOBALS['wp']['taxonomies']         = array( 'product_cat' );
		$GLOBALS['wp']['terms'][16]          = (object) array( 'term_id' => 16, 'taxonomy' => 'product_cat' );
		$GLOBALS['acf']['groups'][]          = array(
			'match'  => function ( $screen ) {
				return 'product_cat' === ( $screen['taxonomy'] ?? '' );
			},
			'fields' => array( array( 'key' => 'field_bottom', 'name' => 'bottom_content', 'label' => 'Bottom content', 'type' => 'wysiwyg' ) ),
		);
		$GLOBALS['acf']['values']['term_16'] = array( 'field_bottom' => '<p>Old</p>' );
		define( 'WPSEO_VERSION', '25.0' );
		require $plugin;
		boot_rest();
		check( '<p>Old</p>' === read_fields( 16, 'product_cat' )['fields']['bottom_content']['value'], 'term field read from ACF id term_16' );
		check( true === rest_update_fields( 16, array( 'fields' => array( 'bottom_content' => '<p>New</p>' ) ), 'product_cat' ), 'term write ok' );
		check( array( 'field_bottom', '<p>New</p>', 'term_16' ) === end( $GLOBALS['acf']['writes'] ), 'saved on term_16' );
		check( isset( $GLOBALS['wp']['fields']['product_cat']['mkt_seo'] ), 'mkt_seo still registered next to mkt_fields' );
		break;

	case 'fields-storage-failure':
		load_acf_page_fixture();
		require $plugin;
		boot_rest();
		$GLOBALS['acf']['throws'] = true;
		check( null === read_fields( 2549, 'page' ), 'read failure gives null, no fatal' );
		$result = rest_update_fields( 2549, array( 'fields' => array( 'hero_title' => 'x' ) ), 'page' );
		check( is_wp_error( $result ) && 'mkt_fields_save_failed' === $result->get_error_code(), 'write failure gives WP_Error, no fatal' );
		break;

	case 'fields-admin-meta-keys':
		$GLOBALS['wp']['admin'] = true;
		require $plugin;
		do_action( 'admin_menu' );
		$_POST = array(
			'_wpnonce'             => 'nonce-mkt_fields_meta_keys',
			'mkt_fields_meta_keys' => "city_intro\nstate_intro, _wp_page_template\nbad.key\ncity_intro",
		);
		try {
			do_action( 'admin_post_mkt_fields_save_meta_keys' );
			check( false, 'redirects after saving' );
		} catch ( Harness_Exit $e ) {
			check( false !== strpos( $e->getMessage(), 'mkt-fields-saved=1' ), 'redirects back to the status page' );
		}
		check( array( 'city_intro', 'state_intro' ) === $GLOBALS['wp']['options']['mkt_fields_meta_keys'], 'keys cleaned and de-duplicated' );
		$_POST['_wpnonce'] = 'forged';
		try {
			do_action( 'admin_post_mkt_fields_save_meta_keys' );
			check( false, 'forged request refused' );
		} catch ( RuntimeException $e ) {
			check( 'nonce check failed' === $e->getMessage(), 'nonce checked' );
		}
		$_POST['_wpnonce']         = 'nonce-mkt_fields_meta_keys';
		$GLOBALS['wp']['can_edit'] = false;
		try {
			do_action( 'admin_post_mkt_fields_save_meta_keys' );
			check( false, 'refused without manage_options' );
		} catch ( Harness_Exit $e ) {
			check( 'die 403' === $e->getMessage(), 'needs manage_options' );
		}
		$GLOBALS['wp']['can_edit'] = true;
		ob_start();
		call_user_func( $GLOBALS['wp']['menu']['mkt-seo-bridge'] );
		$html = ob_get_clean();
		check( false !== strpos( $html, 'mkt_fields_save_meta_keys' ) && false !== strpos( $html, "city_intro\nstate_intro" ), 'form shows the saved keys' );
		check( false !== strpos( $html, 'Advanced Custom Fields is not active' ), 'ACF status shown' );
		break;

	default:
		fwrite( STDERR, "Unknown scenario $scenario\n" );
		exit( 2 );
}

echo "OK $scenario\n";
