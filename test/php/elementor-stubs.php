<?php
/**
 * Stand-ins for the parts of Elementor the bridge uses, loaded only by scenarios that need Elementor:
 * Plugin::$instance->documents->get( $id ) returning a document with save() / is_editable_by_current_user() /
 * set_is_built_with_elementor(), and Plugin::$instance->widgets_manager->get_widget_types().
 * Document::save() stores the elements as Elementor does: JSON text in _elementor_data, slashed for update_metadata.
 */

namespace Elementor;

define( 'ELEMENTOR_VERSION', '3.25.0' );

$GLOBALS['elementor'] = array(
	'saves'         => array(),
	'docs'          => array(),
	'widgets'       => array( 'heading', 'text-editor', 'button', 'image', 'html' ),
	'widgets_throw' => false,
	'save_throws'   => false,
	'no_document'   => array(),
);

class Harness_Document {
	public $post_id;
	public $editable  = true;
	public $save_fails = false;

	public function __construct( $post_id ) {
		$this->post_id = $post_id;
	}

	public function is_editable_by_current_user() {
		return $this->editable;
	}

	public function save( $data ) {
		if ( $GLOBALS['elementor']['save_throws'] ) {
			throw new \RuntimeException( 'elementor exploded' );
		}
		if ( $this->save_fails ) {
			return false;
		}
		$GLOBALS['elementor']['saves'][] = array( $this->post_id, $data );
		if ( isset( $data['elements'] ) ) {
			update_post_meta( $this->post_id, '_elementor_data', wp_slash( wp_json_encode( $data['elements'] ) ) );
		}
		if ( isset( $data['settings'] ) ) {
			$GLOBALS['wp']['meta'][ $this->post_id ]['_elementor_page_settings'] = $data['settings'];
			if ( isset( $data['settings']['template'] ) ) {
				$GLOBALS['wp']['meta'][ $this->post_id ]['_wp_page_template'] = $data['settings']['template'];
			}
		}
		return true;
	}

	public function set_is_built_with_elementor( $on ) {
		$GLOBALS['wp']['meta'][ $this->post_id ]['_elementor_edit_mode'] = $on ? 'builder' : '';
	}
}

class Harness_Documents {
	public function get( $post_id, $from_cache = true ) {
		if ( ! empty( $GLOBALS['elementor']['no_document'][ $post_id ] ) ) {
			return false;
		}
		if ( ! isset( $GLOBALS['elementor']['docs'][ $post_id ] ) ) {
			$GLOBALS['elementor']['docs'][ $post_id ] = new Harness_Document( $post_id );
		}
		return $GLOBALS['elementor']['docs'][ $post_id ];
	}
}

class Harness_Widgets {
	public function get_widget_types() {
		if ( $GLOBALS['elementor']['widgets_throw'] ) {
			throw new \RuntimeException( 'a third-party widget broke' );
		}
		return array_fill_keys( $GLOBALS['elementor']['widgets'], true );
	}
}

class Plugin {
	public static $instance;
	public $documents;
	public $widgets_manager;
}

Plugin::$instance                  = new Plugin();
Plugin::$instance->documents       = new Harness_Documents();
Plugin::$instance->widgets_manager = new Harness_Widgets();
