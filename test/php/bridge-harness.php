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
	return $GLOBALS['wp']['can_edit'];
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

// ---- scenarios ----------------------------------------------------------------------------------------------
switch ( $scenario ) {
	case 'all-post-types-and-taxonomies':
		$GLOBALS['wp']['types']      = array( 'post', 'page', 'product', 'locations' );
		$GLOBALS['wp']['taxonomies'] = array( 'category', 'post_tag', 'product_cat', 'product_tag', 'nav_menu', 'post_format', 'wp_pattern_category' );
		define( 'WPSEO_VERSION', '25.0' );
		require $plugin;
		boot_rest();
		check( isset( $GLOBALS['wp']['fields']['tag']['mkt_seo'] ) && ! isset( $GLOBALS['wp']['fields']['post_tag'] ), 'tags registered under "tag", the name the WordPress terms controller uses' );
		foreach ( array( 'post', 'page', 'product', 'locations', 'category', 'product_cat', 'product_tag' ) as $type ) {
			check( isset( $GLOBALS['wp']['fields'][ $type ]['mkt_seo'] ), "field on $type" );
		}
		foreach ( array( 'attachment', 'nav_menu', 'post_format', 'wp_pattern_category' ) as $type ) {
			check( ! isset( $GLOBALS['wp']['fields'][ $type ] ), "no field on internal $type" );
		}
		check( array( '1.2.2' ) === field( 'product_cat' )['schema']['properties']['version']['enum'], 'term schema reports version' );
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
		check( array( '1.2.2' ) === $schema['properties']['version']['enum'], 'advertises version' );
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
		check( 'New title' === $value['title'] && 'yoast' === $value['plugin'] && '1.2.2' === $value['version'], 'read back' );
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

	default:
		fwrite( STDERR, "Unknown scenario $scenario\n" );
		exit( 2 );
}

echo "OK $scenario\n";
